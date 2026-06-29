/** EventLedger —— per-agent append-only WAL，5MB shard 自动滚。
 *
 *  与 agenteam ref 280 行的差异（plan §3.4）：
 *  - **构造参数**：`(sid, agentPath, paths)` 而非 `agentId`；ledger / blobs 路径走
 *    `paths.session(sid).agent(agentPath).{root, eventLedgerBlobs}`。
 *    shard 文件名沿用 `events-<N>.jsonl`（5MB 拆分用，不是切 ledger）。
 *  - **砍 currentSessionId 指针 + newSession / switchSession**：forgeax 一棵 agent 一份
 *    ledger，没切换语义；要换历史另起 sid。
 *  - **砍 xml-renderer.scheduleRender**：xml.ts 本轮延后（plan §3.4）。
 *  - **rotation 边界**：与 ref 一致（5MB / 每 20 次 append 检测一次）。
 *
 *  线程模型：单进程内部使用，append 同步写盘；rotate 内部 _rotating flag 防重入。
 *  Caller（Session.ledgers map 持有者）需在 dispose 时停止使用，本类不主动 close。 */

import { mkdirSync, statSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "../core/types";
import type { PathManagerAPI } from "../fs/types";
import { parseEvents } from "./event-store";
import { walkAndExternalize } from "./event-blob";
import type { StoredEvent } from "./types";

const MAX_SHARD_BYTES = 5 * 1024 * 1024;
const SIZE_CHECK_INTERVAL = 20;
const SHARD_RE = /^events-(\d+)\.jsonl$/;

export class EventLedger {
  private readonly eventsDir: string;
  private readonly blobsDir: string;
  private _currentShard = 1;
  private _appendCount = 0;
  private _rotating = false;
  // True once we've confirmed eventsDir exists. _initShardIndex() already
  // mkdirs at construction, but a paranoid append() previously re-created
  // it on every event — that's a stat-class syscall on every WS event.
  // Keep the safety net but skip it after the first successful append.
  private _dirEnsured = false;

  constructor(
    public readonly sid: string,
    public readonly agentPath: string,
    paths: PathManagerAPI,
  ) {
    const layer = paths.session(sid).agent(agentPath);
    this.eventsDir = layer.eventsDir();
    this.blobsDir = layer.eventLedgerBlobs();
    this._initShardIndex();
  }

  // ─── Shard info ─────────────────────────────────────────────────────────

  get shardCount(): number {
    return this._currentShard;
  }

  private _shardPath(n: number): string {
    return join(this.eventsDir, `events-${n}.jsonl`);
  }

  private _currentShardPath(): string {
    return this._shardPath(this._currentShard);
  }

  /** Sorted list of existing shard paths（按 N 升序，缺号容错）。 */
  private _listShardPaths(): string[] {
    if (!existsSync(this.eventsDir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(this.eventsDir);
    } catch {
      return [];
    }
    const shards: Array<[number, string]> = [];
    for (const f of entries) {
      const m = SHARD_RE.exec(f);
      if (m) shards.push([parseInt(m[1], 10), join(this.eventsDir, f)]);
    }
    shards.sort((a, b) => a[0] - b[0]);
    return shards.map(([, p]) => p);
  }

  // ─── Event I/O ─────────────────────────────────────────────────────────

  /** 持久化一条 bus Event 到当前 shard。
   *  emitterId 由 EventBus 在 emit 时捕获，原样落盘。
   *  payload 在外置前 deep-clone，确保 in-memory observer 看到的对象不被改写。 */
  append(event: Event, emitterId?: string): void {
    const stored: StoredEvent = {
      type: event.type,
      ts: event.ts,
      source: event.source,
      to: event.to,
      emitterId,
      priority: event.priority,
      handoff: event.handoff,
      payload: event.payload && typeof event.payload === "object"
        ? structuredClone(event.payload as Record<string, unknown>)
        : event.payload,
    };
    if (stored.payload && typeof stored.payload === "object") {
      walkAndExternalize(stored.payload, this.blobsDir);
    }
    if (!this._dirEnsured) {
      mkdirSync(this.eventsDir, { recursive: true });
      this._dirEnsured = true;
    }
    appendFileSync(this._currentShardPath(), JSON.stringify(stored) + "\n", "utf-8");

    this._appendCount++;
    if (this._appendCount >= SIZE_CHECK_INTERVAL) {
      this._appendCount = 0;
      this._maybeRotate();
    }
  }

  async readAllEvents(): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    for (const path of this._listShardPaths()) {
      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (err) {
        process.stderr.write(`[ledger] ${this.agentPath}: skip unreadable shard ${path}: ${(err as Error).message}\n`);
        continue;
      }
      // parseEvents 可能抛 LedgerBlobMissingError —— 当 WAL 完整性错误向上抛，
      // 不静默丢整 shard（会丢最近上下文）。
      all.push(...parseEvents(raw, this.blobsDir));
    }
    return all;
  }

  /** 倒序读 shard，直到 isEnough(accumulated) 为 true 或全部读完；用于 summary 边界反扫。 */
  async readFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> {
    const paths = this._listShardPaths();
    const result: StoredEvent[] = [];
    for (let i = paths.length - 1; i >= 0; i--) {
      let raw: string;
      try {
        raw = await readFile(paths[i], "utf-8");
      } catch (err) {
        process.stderr.write(`[ledger] ${this.agentPath}: skip unreadable shard ${paths[i]}: ${(err as Error).message}\n`);
        continue;
      }
      const batch = parseEvents(raw, this.blobsDir);
      result.unshift(...batch);
      if (isEnough(result)) break;
    }
    return result;
  }

  // ─── Init helpers ──────────────────────────────────────────────────────

  private _initShardIndex(): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch { /* exists */ }

    let max = 0;
    try {
      for (const f of readdirSync(this.eventsDir)) {
        const m = SHARD_RE.exec(f);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch { /* empty dir */ }
    this._currentShard = max > 0 ? max : 1;
  }

  private _maybeRotate(): void {
    if (this._rotating) return;
    try {
      const size = statSync(this._currentShardPath()).size;
      if (size < MAX_SHARD_BYTES) return;
    } catch {
      return;
    }
    this._rotating = true;
    this._currentShard++;
    process.stderr.write(`[ledger] ${this.agentPath}: shard rotated to events-${this._currentShard}.jsonl\n`);
    this._rotating = false;
  }
}
