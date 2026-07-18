/** perception-registry —— 感知接地(R5/M8 L1)的两个进程内中枢。
 *
 *  1. 取数往返(host-forced verification, R5 §C.3):内核 turn 经 `query_world` /
 *     `capture_frame` 工具 → fxt MCP server HTTP 回打 `/:sid/perception-query`,
 *     本 registry 注册一个**阻塞 Promise** + 经 EventBus 把 `perception:query` 推给
 *     interface;interface 向 preview iframe postMessage 取真值,拿到后 POST
 *     `/:sid/perception-reply` 解开它。键用随机 **reqId**(一轮可并发多次取数)。
 *     镜像 `permission-registry.ts`,但 resolve 的是 **snapshot(unknown)** 而非
 *     boolean,且超时 fail-soft 返回 `{ unavailable, reason:'timeout' }`(取数失败
 *     不该让 turn 挂死——它只是少一份感知证据)。
 *
 *  2. L1 错误回灌(R5 §C.4 / M8):游戏运行期 `VAG_CONSOLE{error}` /
 *     `VAG_PREVIEW_ERROR` 由 interface POST `/:sid/perception` 进来,push 进 per-sid
 *     **环形缓冲**;下一轮 `composeTurnRequest` 把它 drain 进 `dynamicSuffix`(user
 *     后缀,不打碎 prompt-cache 前缀,守 contract §2.2.1)。
 *
 *  模块级 Map(单进程 Bun 安全)。重启丢在途请求(其 held HTTP 调用超时 fail-soft)。
 */

// ─── 取数往返:挂起 Promise 表 ──────────────────────────────────────────────

import { validateUiLease } from './ui-manifest-registry';

interface PendingPerception {
  resolve: (snapshot: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** ui_* 类查询(UI 语义操作层):回灌方必须持有该 sid 的有效 lease(声明与执行方
   *  同源约束,见 ui-manifest-registry 文件头)。world/frame 传统查询不设此要求。 */
  requireLease?: { sid: string };
}

const pending = new Map<string, PendingPerception>();

export interface PerceptionHandle {
  /** Resolves with the snapshot the UI returned, or a `{ unavailable }`
   *  sentinel on timeout — fail-soft, never reject (a missing snapshot must
   *  not crash the turn). */
  promise: Promise<unknown>;
  /** Idempotent cleanup — drop entry + clear timer. Call in finally. */
  dispose(): void;
}

/** Register a pending perception query. Resolves when the UI replies via
 *  `resolvePerception(reqId, …)`, or to a `{ unavailable }` sentinel on timeout.
 *  `opts.requireLease` 使回灌被 lease 把关(ui_* 查询用;world/frame 不传,零回归)。 */
export function registerPerception(
  reqId: string,
  timeoutMs: number,
  opts: { requireLease?: { sid: string } } = {},
): PerceptionHandle {
  const prev = pending.get(reqId);
  if (prev) {
    clearTimeout(prev.timer);
    prev.resolve({ unavailable: true, reason: 'superseded' });
    pending.delete(reqId);
  }

  let settle!: (snapshot: unknown) => void;
  const promise = new Promise<unknown>((res) => { settle = res; });

  const timer = setTimeout(() => {
    if (pending.get(reqId)?.resolve === settle) pending.delete(reqId);
    settle({ unavailable: true, reason: 'timeout' }); // fail-soft
  }, timeoutMs);

  pending.set(reqId, { resolve: settle, timer, ...(opts.requireLease ? { requireLease: opts.requireLease } : {}) });

  return {
    promise,
    dispose() {
      const cur = pending.get(reqId);
      if (cur && cur.resolve === settle) {
        clearTimeout(cur.timer);
        pending.delete(reqId);
      }
    },
  };
}

/** Resolve a pending perception query with the snapshot the UI returned.
 *  Returns true when a matching entry was found (and, for lease-gated entries,
 *  the reply carried the current valid leaseId), false otherwise.
 *  lease 校验不通过时**不消费** pending——真正的持有者仍可回灌。 */
export function resolvePerception(reqId: string, snapshot: unknown, leaseId?: unknown): boolean {
  const entry = pending.get(reqId);
  if (!entry) return false;
  if (entry.requireLease && !validateUiLease(entry.requireLease.sid, leaseId)) return false;
  clearTimeout(entry.timer);
  pending.delete(reqId);
  entry.resolve(snapshot);
  return true;
}

// ─── L1 回灌:per-sid 错误环形缓冲 ──────────────────────────────────────────

export interface PerceptionNote {
  level: 'error' | 'warn';
  text: string;
  ts: number;
}

/** 每个 sid 最多保留的回灌条数(防止刷屏淹没 prompt;FIFO 丢旧)。 */
const MAX_NOTES_PER_SID = 10;
const notes = new Map<string, PerceptionNote[]>();

/** Push one runtime-feedback note for a session. Oldest dropped past the cap. */
export function pushPerceptionNote(sid: string, note: PerceptionNote): void {
  if (!sid || !note.text.trim()) return;
  const buf = notes.get(sid) ?? [];
  buf.push(note);
  if (buf.length > MAX_NOTES_PER_SID) buf.splice(0, buf.length - MAX_NOTES_PER_SID);
  notes.set(sid, buf);
}

/** Drain (read + clear) all buffered notes for a session — called once per turn
 *  by `composeTurnRequest`. Returns [] when there's nothing pending. */
export function drainPerceptionNotes(sid: string | undefined): PerceptionNote[] {
  if (!sid) return [];
  const buf = notes.get(sid);
  if (!buf || buf.length === 0) return [];
  notes.delete(sid);
  return buf;
}
