/** CheckpointManager —— checkpoint 回退点的 session 级编排。
 *
 *  职责:
 *  - 每条用户消息 emit 前对游戏目录拍 CAS 快照(消息锚点,失败不阻塞聊天);
 *  - rewind / cancel(Cursor 软回退)/ overwriteDirty / undoOverwrite 编排:
 *      interrupt → pre-rewind 快照(fail-closed)→ 脏文件处理 → restore →
 *      boundary 事件落各 agent ledger → eventBus 通知 UI;
 *  - 定格规则:新 user_input 到达时 finalizePending(此后 cancel 失效);
 *  - 索引:<session>/checkpoints.jsonl(append-only),重启可重建。
 *
 *  并发:per-session promise 链互斥,所有 restore 类操作串行。 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { getPathManager } from "../fs/path-manager";
import type { Session } from "../core/session";
import type { Event } from "../core/types";
import { SnapshotStore, type DiffStats, type Manifest } from "./snapshot-store";
import { REWIND_BOUNDARY, REWIND_CANCEL } from "./rewind-mask";

export type RewindMode = "both" | "conversation" | "code";

interface MessageRecord {
  kind: "message";
  msgId: string;
  ts: number;
  manifestId: string | null; // null = 该消息时刻无游戏目录 / 快照失败
}

interface RewindRecord {
  kind: "rewind";
  boundaryId: string;
  targetMsgId: string;
  mode: RewindMode;
  ts: number;
  preManifestId: string | null;   // 回退前盘上状态(恢复的落点)
  keptDirty: string[];
}

interface StatusRecord {
  kind: "rewind-status";
  boundaryId: string;
  status: "cancelled" | "finalized";
  ts: number;
}

interface OverwriteRecord {
  kind: "overwrite";
  boundaryId: string;
  safetyManifestId: string;
  files: string[];
  ts: number;
}

type CheckpointJsonlRecord = MessageRecord | RewindRecord | StatusRecord | OverwriteRecord
  | { kind: "overwrite-undo"; boundaryId: string; ts: number };

export interface PendingRewind {
  boundaryId: string;
  targetMsgId: string;
  mode: RewindMode;
  preManifestId: string | null;
  keptDirty: string[];
  /** 「这些文件也回退」之后的撤销锚点。 */
  overwrite: { safetyManifestId: string; files: string[] } | null;
}

class SessionCheckpoints {
  readonly messages = new Map<string, MessageRecord>();
  readonly order: string[] = []; // msgId 时间序
  pending: PendingRewind | null = null;
  /** 上次 restore 把盘面带到的 manifest;脏检测基准。null = 从未 restore。 */
  lastRestoreManifestId: string | null = null;
  /** 最近一次 restore 类操作(rewind **或** cancel)的脏文件账本。
   *  「这些文件也回退 / 撤销」挂在这上面而不是 pending 上 —— 用户核心场景
   *  「回退→手改→恢复(cancel)→这些文件也回退」发生在 pending 已清空之后。
   *  opId 复用 boundaryId。 */
  lastOp: {
    opId: string;
    keptDirty: string[];
    restoreTargetManifestId: string | null;
    overwrite: { safetyManifestId: string; files: string[] } | null;
  } | null = null;
  loaded = false;
  lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly sid: string,
    readonly indexFile: string,
    readonly gameDir: string | null,
    readonly store: SnapshotStore | null,
  ) {}
}

export class CheckpointManager {
  private readonly sessions = new Map<string, SessionCheckpoints>();
  private readonly stores = new Map<string, SnapshotStore>();

  // ─── per-session state ───────────────────────────────────────────────────

  private ensure(session: Session): SessionCheckpoints {
    let sc = this.sessions.get(session.sid);
    if (!sc) {
      const pm = getPathManager();
      const slug = session.config.defaultDir;
      let gameDir: string | null = null;
      let store: SnapshotStore | null = null;
      try {
        const dir = pm.user().gameDir(slug);
        if (existsSync(dir)) {
          gameDir = dir;
          store = this.stores.get(slug) ?? null;
          if (!store) {
            store = new SnapshotStore(`${pm.user().root()}/checkpoints/${slug}`);
            this.stores.set(slug, store);
          }
        }
      } catch {
        /* defaultDir 不是合法 slug('default' 无目录等)→ 纯会话模式 */
      }
      sc = new SessionCheckpoints(
        session.sid,
        `${pm.session(session.sid).root()}/checkpoints.jsonl`,
        gameDir,
        store,
      );
      this.sessions.set(session.sid, sc);
    }
    if (!sc.loaded) this.loadIndex(sc);
    return sc;
  }

  /** 重启后从 checkpoints.jsonl 重建内存状态。 */
  private loadIndex(sc: SessionCheckpoints): void {
    sc.loaded = true;
    let raw: string;
    try {
      raw = readFileSync(sc.indexFile, "utf-8");
    } catch {
      return; // 新 session
    }
    const rewinds = new Map<string, RewindRecord>();
    const status = new Map<string, StatusRecord["status"]>();
    const overwrites = new Map<string, OverwriteRecord | null>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: CheckpointJsonlRecord;
      try {
        rec = JSON.parse(line) as CheckpointJsonlRecord;
      } catch {
        continue;
      }
      if (rec.kind === "message") {
        if (!sc.messages.has(rec.msgId)) sc.order.push(rec.msgId);
        sc.messages.set(rec.msgId, rec);
      } else if (rec.kind === "rewind") {
        rewinds.set(rec.boundaryId, rec);
        status.delete(rec.boundaryId);
        overwrites.set(rec.boundaryId, null);
      } else if (rec.kind === "rewind-status") {
        status.set(rec.boundaryId, rec.status);
      } else if (rec.kind === "overwrite") {
        overwrites.set(rec.boundaryId, rec);
      } else if (rec.kind === "overwrite-undo") {
        overwrites.set(rec.boundaryId, null);
      }
    }
    // 最后一条仍 pending 的 rewind(没有 cancelled/finalized 状态)恢复为挂起态
    let lastPending: RewindRecord | null = null;
    for (const r of rewinds.values()) {
      if (!status.has(r.boundaryId)) lastPending = !lastPending || r.ts > lastPending.ts ? r : lastPending;
    }
    if (lastPending) {
      const ow = overwrites.get(lastPending.boundaryId) ?? null;
      sc.pending = {
        boundaryId: lastPending.boundaryId,
        targetMsgId: lastPending.targetMsgId,
        mode: lastPending.mode,
        preManifestId: lastPending.preManifestId,
        keptDirty: lastPending.keptDirty,
        overwrite: ow ? { safetyManifestId: ow.safetyManifestId, files: ow.files } : null,
      };
      const target = sc.messages.get(lastPending.targetMsgId);
      if (lastPending.mode !== "conversation" && target?.manifestId) {
        sc.lastRestoreManifestId = target.manifestId;
      }
    }
  }

  private record(sc: SessionCheckpoints, rec: CheckpointJsonlRecord): void {
    appendFileSync(sc.indexFile, JSON.stringify(rec) + "\n", "utf-8");
  }

  private withLock<T>(sc: SessionCheckpoints, fn: () => Promise<T>): Promise<T> {
    const run = sc.lock.then(fn, fn);
    sc.lock = run.catch(() => undefined);
    return run;
  }

  // ─── message snapshot(A 组)────────────────────────────────────────────

  /** 用户消息 emit 前调用。失败不抛(快照失败不阻塞聊天,只是该消息无
   *  代码回退能力);纯会话(无游戏目录)记录 manifestId=null,会话回退仍可用。 */
  snapshotForMessage(session: Session, msgId: string): void {
    const sc = this.ensure(session);
    let manifestId: string | null = null;
    if (sc.store && sc.gameDir) {
      try {
        manifestId = sc.store.snapshot(sc.gameDir, { sid: session.sid, msgId }).id;
      } catch (err) {
        process.stderr.write(
          `[checkpoint] snapshot for ${session.sid}/${msgId} failed: ${(err as Error).message}\n`,
        );
        return; // 连索引都不记 —— UI 不出回退入口
      }
    }
    const rec: MessageRecord = { kind: "message", msgId, ts: Date.now(), manifestId };
    try {
      this.record(sc, rec);
    } catch (err) {
      process.stderr.write(`[checkpoint] index append failed: ${(err as Error).message}\n`);
      return;
    }
    if (!sc.messages.has(msgId)) sc.order.push(msgId);
    sc.messages.set(msgId, rec);
  }

  // ─── queries ─────────────────────────────────────────────────────────────

  list(session: Session): Array<{ msgId: string; ts: number; hasCode: boolean }> {
    const sc = this.ensure(session);
    return sc.order.map((msgId) => {
      const r = sc.messages.get(msgId)!;
      return { msgId, ts: r.ts, hasCode: r.manifestId !== null };
    });
  }

  pendingOf(session: Session): PendingRewind | null {
    return this.ensure(session).pending;
  }

  /** 确认弹窗的 diff 预览。 */
  preview(session: Session, msgId: string): DiffStats | { error: string; status: number } {
    const sc = this.ensure(session);
    const rec = sc.messages.get(msgId);
    if (!rec) return { error: `unknown msgId: ${msgId}`, status: 404 };
    if (!rec.manifestId || !sc.store || !sc.gameDir) {
      return { filesChanged: [], insertions: 0, deletions: 0, binaryOrLarge: 0, files: [] };
    }
    const manifest = sc.store.loadManifest(rec.manifestId);
    if (!manifest) return { error: `manifest missing for ${msgId}`, status: 410 };
    return sc.store.diffStats(sc.gameDir, manifest);
  }

  // ─── restore-class operations(全部走 per-session 锁)──────────────────

  /** 回退。
   *  全新回退 = 干净还原(disk 精确等于目标 checkpoint);仅"挂起态内再回退"
   *  才保留挂起期间手改——否则正常回退里"基线之后出现的文件"会被
   *  误判脏文件保留,导致"回退删不掉文件"(2026-06-14 修)。 */
  rewind(
    session: Session,
    msgId: string,
    mode: RewindMode,
  ): Promise<
    | { boundaryId: string; filesChanged: string[]; keptDirty: string[]; targetTs: number }
    | { error: string; status: number }
  > {
    const sc = this.ensure(session);
    return this.withLock(sc, async () => {
      const rec = sc.messages.get(msgId);
      if (!rec) return { error: `unknown msgId: ${msgId}`, status: 404 };
      if (mode !== "conversation" && !rec.manifestId) {
        return { error: `msgId ${msgId} has no code checkpoint`, status: 409 };
      }

      // 是否"挂起态内再回退"。手改防护(keptDirty)只对这种场景生效。在 cancel
      // 旧 pending 前捕获。
      const wasPending = sc.pending != null;

      // 1. 停掉进行中的 turn;给事件 flush 留一拍,避免半截 turn 落在 boundary 后
      session.scheduler.interruptAgents();
      await sleep(120);

      // 1.5 挂起态再回退:单活跃 boundary 模型 —— 旧 boundary 作废(cancel),
      // 新 boundary 接管;恢复锚点继承第一次回退前的状态,Redo 永远回到「回退前最新」。
      let inheritedPre: string | null = null;
      if (sc.pending) {
        const old = sc.pending;
        inheritedPre = old.preManifestId;
        if (old.mode !== "code") {
          this.appendToAllLedgers(session, {
            type: REWIND_CANCEL,
            ts: Date.now(),
            source: "system",
            payload: { boundaryId: old.boundaryId },
          });
        }
        this.record(sc, { kind: "rewind-status", boundaryId: old.boundaryId, status: "cancelled", ts: Date.now() });
        sc.pending = null;
      }

      // 2. pre-rewind 快照 —— 恢复(cancel)的落点。fail-closed:拍不下来就不回退。
      let preManifestId: string | null = inheritedPre;
      if (!preManifestId && sc.store && sc.gameDir) {
        try {
          preManifestId = sc.store.snapshot(sc.gameDir, { sid: session.sid, kind: "pre-rewind" }).id;
        } catch (err) {
          return { error: `pre-rewind snapshot failed: ${(err as Error).message}`, status: 500 };
        }
      }

      // 3. 代码回退。全新回退 = 干净还原(exclude 空);仅"挂起态内再回退"才
      //    保留挂起期间的手改。
      let filesChanged: string[] = [];
      let keptDirty: string[] = [];
      const boundaryId = randomUUID();
      if (mode !== "conversation" && sc.store && sc.gameDir && rec.manifestId) {
        const target = sc.store.loadManifest(rec.manifestId);
        if (!target) return { error: `manifest missing for ${msgId}`, status: 410 };
        const dirty = wasPending ? this.dirtySet(sc) : new Set<string>();
        const res = sc.store.restore(sc.gameDir, target, { exclude: dirty });
        filesChanged = [...res.written, ...res.deleted];
        keptDirty = res.skippedDirty;
        sc.lastRestoreManifestId = rec.manifestId;
        sc.lastOp = { opId: boundaryId, keptDirty, restoreTargetManifestId: rec.manifestId, overwrite: null };
      }

      // 4. 会话 boundary 落账(所有 agent —— 子 agent 联动)
      if (mode !== "code") {
        this.appendToAllLedgers(session, {
          type: REWIND_BOUNDARY,
          ts: Date.now(),
          source: "system",
          payload: { boundaryId, targetMsgId: msgId, targetTs: rec.ts, mode },
        });
      }

      // 5. 索引 + 挂起态 + UI 通知
      const rrec: RewindRecord = {
        kind: "rewind", boundaryId, targetMsgId: msgId, mode,
        ts: Date.now(), preManifestId, keptDirty,
      };
      this.record(sc, rrec);
      sc.pending = { boundaryId, targetMsgId: msgId, mode, preManifestId, keptDirty, overwrite: null };
      this.notify(session, "rewind:done", { boundaryId, msgId, mode, filesChanged, keptDirty });
      return { boundaryId, filesChanged, keptDirty, targetTs: rec.ts };
    });
  }

  /** 恢复(Redo checkpoint)。挂起态手改默认保留。 */
  cancel(
    session: Session,
    boundaryId: string,
  ): Promise<{ keptDirty: string[] } | { error: string; status: number }> {
    const sc = this.ensure(session);
    return this.withLock(sc, async () => {
      if (!sc.pending || sc.pending.boundaryId !== boundaryId) {
        return { error: `boundary ${boundaryId} is not pending (cancelled/finalized/unknown)`, status: 409 };
      }
      const pending = sc.pending;
      let keptDirty: string[] = [];
      if (pending.preManifestId && sc.store && sc.gameDir) {
        const pre = sc.store.loadManifest(pending.preManifestId);
        if (!pre) return { error: `pre-rewind manifest missing`, status: 410 };
        const dirty = this.dirtySet(sc);
        const res = sc.store.restore(sc.gameDir, pre, { exclude: dirty });
        keptDirty = res.skippedDirty;
        sc.lastRestoreManifestId = pending.preManifestId;
        sc.lastOp = {
          opId: boundaryId, keptDirty,
          restoreTargetManifestId: pending.preManifestId, overwrite: null,
        };
      }
      if (pending.mode !== "code") {
        this.appendToAllLedgers(session, {
          type: REWIND_CANCEL,
          ts: Date.now(),
          source: "system",
          payload: { boundaryId },
        });
      }
      this.record(sc, { kind: "rewind-status", boundaryId, status: "cancelled", ts: Date.now() });
      sc.pending = null;
      this.notify(session, "rewind:cancelled", { boundaryId, keptDirty });
      return { keptDirty };
    });
  }

  /** 「这些文件也回退」:显式覆盖上次 restore 保留的脏文件,覆盖前
   *  safety 快照 fail-closed。挂在 lastOp(rewind 或 cancel)上,不要求仍处
   *  挂起态 —— 「回退→手改→恢复→这些文件也回退」是核心场景。 */
  overwriteDirty(
    session: Session,
    boundaryId: string,
  ): Promise<{ files: string[] } | { error: string; status: number }> {
    const sc = this.ensure(session);
    return this.withLock(sc, async () => {
      const op = sc.lastOp;
      if (!op || op.opId !== boundaryId) {
        return { error: `boundary ${boundaryId} is not the latest restore op`, status: 409 };
      }
      if (!sc.store || !sc.gameDir || !op.restoreTargetManifestId) {
        return { error: "no code restore in effect", status: 409 };
      }
      if (op.keptDirty.length === 0) return { files: [] };
      const files = new Set(op.keptDirty);
      // safety 快照(第 1 层):同步成功后才触盘,失败整体中止
      let safetyManifestId: string;
      try {
        safetyManifestId = sc.store.snapshot(sc.gameDir, { sid: session.sid, kind: "safety" }).id;
      } catch (err) {
        return { error: `safety snapshot failed, aborted: ${(err as Error).message}`, status: 500 };
      }
      const target = sc.store.loadManifest(op.restoreTargetManifestId);
      if (!target) return { error: "restore target manifest missing", status: 410 };
      sc.store.restore(sc.gameDir, target, { only: files });
      const fileList = [...files];
      this.record(sc, { kind: "overwrite", boundaryId, safetyManifestId, files: fileList, ts: Date.now() });
      op.overwrite = { safetyManifestId, files: fileList };
      op.keptDirty = [];
      if (sc.pending?.boundaryId === boundaryId) {
        sc.pending.overwrite = op.overwrite;
        sc.pending.keptDirty = [];
      }
      this.notify(session, "rewind:overwrite", { boundaryId, files: fileList });
      return { files: fileList };
    });
  }

  /** 「撤销」:把被覆盖的脏文件从 safety 快照写回。 */
  undoOverwrite(
    session: Session,
    boundaryId: string,
  ): Promise<{ files: string[] } | { error: string; status: number }> {
    const sc = this.ensure(session);
    return this.withLock(sc, async () => {
      const op = sc.lastOp;
      if (!op || op.opId !== boundaryId || !op.overwrite) {
        return { error: `no overwrite to undo for ${boundaryId}`, status: 409 };
      }
      if (!sc.store || !sc.gameDir) return { error: "no code store", status: 409 };
      const safety = sc.store.loadManifest(op.overwrite.safetyManifestId);
      if (!safety) return { error: "safety manifest missing", status: 410 };
      const files = new Set(op.overwrite.files);
      sc.store.restore(sc.gameDir, safety, { only: files });
      this.record(sc, { kind: "overwrite-undo", boundaryId, ts: Date.now() });
      op.keptDirty = op.overwrite.files;
      op.overwrite = null;
      if (sc.pending?.boundaryId === boundaryId) {
        sc.pending.keptDirty = op.keptDirty;
        sc.pending.overwrite = null;
      }
      this.notify(session, "rewind:overwrite-undone", { boundaryId, files: [...files] });
      return { files: [...files] };
    });
  }

  /** 新 user_input 到达 → 定格。messages 路由在 emit 前调用。 */
  finalizePending(session: Session): void {
    const sc = this.ensure(session);
    if (!sc.pending) return;
    const boundaryId = sc.pending.boundaryId;
    this.record(sc, { kind: "rewind-status", boundaryId, status: "finalized", ts: Date.now() });
    sc.pending = null;
    this.notify(session, "rewind:finalized", { boundaryId });
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /** 挂起态脏检测:diff(当前盘, 上次 restore 落点)→ changed + onlyOnDisk。
   *  无 restore 基准(从未 code 回退)→ 空集。 */
  private dirtySet(sc: SessionCheckpoints): Set<string> {
    if (!sc.store || !sc.gameDir || !sc.lastRestoreManifestId) return new Set();
    const baseline = sc.store.loadManifest(sc.lastRestoreManifestId);
    if (!baseline) return new Set();
    const d = sc.store.diffDiskVsManifest(sc.gameDir, baseline);
    return new Set([...d.changed, ...d.onlyOnDisk]);
  }

  /** boundary/cancel 直接 append 进每个 agent 的 WAL(确定性,不走 bus 路由)。 */
  private appendToAllLedgers(session: Session, event: Event): void {
    for (const node of session.tree.list()) {
      try {
        session.getOrCreateLedger(node.path).append(event);
      } catch (err) {
        process.stderr.write(
          `[checkpoint] ledger append ${event.type} to ${node.path} failed: ${(err as Error).message}\n`,
        );
      }
    }
  }

  /** 瞬态 UI 通知:无 to / 无 emitterId → 只进 WS observer,不落 WAL。 */
  private notify(session: Session, type: string, payload: Record<string, unknown>): void {
    try {
      session.eventBus.emit({ type, ts: Date.now(), source: "system", payload } as Event);
    } catch {
      /* UI 通知失败不影响状态 */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _instance: CheckpointManager | null = null;
export function getCheckpointManager(): CheckpointManager {
  if (!_instance) _instance = new CheckpointManager();
  return _instance;
}
