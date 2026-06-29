/** ask-user-registry —— `ask_user` 工具的「阻塞 + HTTP 回执」往返中枢。
 *
 *  `ask_user` 工具在 execute() 里 registerAsk()，拿到一个会阻塞的 Promise；
 *  前端选完后 `POST /api/sessions/:sid/ask-reply` 调 resolveAsk() 把它解开。
 *
 *  与 `src/tools/registry.ts::awaitConfirm` 同款模式：模块级 Map<token, resolve>，
 *  单进程（Bun）安全。token = `${sid}::${agentPath}` —— 工具默认串行
 *  (tool-batch-runner partition)，故同一 agent 同一时刻至多一个 ask 在 pending，
 *  键天然唯一，无需 tool_call id。 */

import { tt } from '../lib/turn-trace';

interface Pending {
  resolve: (values: string[] | null) => void;
  /** 仅在传了有限正超时时存在;缺省 = 无超时(像 the reference agent CLI 一样无限等用户回答)。 */
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

function keyOf(sid: string, agentPath: string): string {
  return `${sid}::${agentPath}`;
}

export interface AskHandle {
  /** Resolves to the chosen label array, or null when aborted / timed out. */
  promise: Promise<string[] | null>;
  /** Idempotent cleanup —— removes the pending entry + clears the timer. */
  dispose(): void;
}

/** Register a pending ask. The returned promise resolves when the UI replies
 *  via resolveAsk(). `timeoutMs <= 0`(或非有限)= **无超时**:像 the reference agent CLI 的
 *  AskUserQuestion 一样无限等用户回答(用户答 或 中断本轮 abort → dispose 才结束),
 *  绝不因"超时"替用户作答。Always call dispose() in a finally to drop the entry. */
export function registerAsk(sid: string, agentPath: string, timeoutMs: number): AskHandle {
  const key = keyOf(sid, agentPath);
  // Drop any stale pending under the same key (e.g. a previous ask that the
  // user never answered and which is being superseded).
  const prev = pending.get(key);
  if (prev) {
    if (prev.timer) clearTimeout(prev.timer);
    prev.resolve(null);
    pending.delete(key);
  }

  let settle!: (values: string[] | null) => void;
  const promise = new Promise<string[] | null>((res) => {
    settle = res;
  });

  // 仅当传了有限正超时才挂定时器;否则无超时(无限等)。
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          if (pending.get(key)?.resolve === settle) pending.delete(key);
          settle(null);
        }, timeoutMs)
      : undefined;

  pending.set(key, { resolve: settle, ...(timer ? { timer } : {}) });
  tt('ask.register', { key, sid, agentPath, timeoutMs });

  return {
    promise,
    dispose() {
      const cur = pending.get(key);
      if (cur && cur.resolve === settle) {
        if (cur.timer) clearTimeout(cur.timer);
        pending.delete(key);
      }
      // 必须 settle(null) 才能解开 `await handle.promise` —— 无超时后,abort/中断
      // 走 dispose 这条路解除阻塞(已被 resolveAsk 答过则此处幂等 no-op)。
      settle(null);
    },
  };
}

/** Resolve a pending ask with the user's selection. Returns true when a
 *  matching pending entry was found and resolved, false otherwise (already
 *  answered / timed out / unknown key). */
export function resolveAsk(sid: string, agentPath: string, values: string[]): boolean {
  const exactKey = keyOf(sid, agentPath);
  let key = exactKey;
  let entry = pending.get(key);
  // 回执 agent 对不上时的兜底:前端卡片可能回的是当前 tab 的 agent,而 ask 是
  // 被委派子 agent(ctx.agentPath)注册的 → 精确键 miss。若该 sid 下**恰好只有一个**
  // 待答 ask,就解它(同 sid 同一刻至多一个 ask 在 pending,见文件头不变量)。
  if (!entry) {
    const sidKeys = [...pending.keys()].filter((k) => k.startsWith(`${sid}::`));
    if (sidKeys.length === 1) {
      key = sidKeys[0]!;
      entry = pending.get(key);
    }
  }
  tt('ask.resolve', { exactKey, resolvedKey: key, sid, agentPath, found: !!entry, pendingKeys: [...pending.keys()].join('|') });
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(key);
  entry.resolve(values);
  return true;
}
