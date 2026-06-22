// @desc EventLedger — sharded event storage (internal to AgentLedger).
//
// "Shard" here means a size-bounded chunk of one agent's event log
// (shard_<ts>/events-N.jsonl). It is NOT a daemon-level Session — that
// concept lives one layer up in SessionRuntime / SessionRegistry. An
// AgentLedger sits inside one agent inside one Session and rotates
// shards as the log grows.

import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readFile, stat as statAsync } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extension as mimeExtension } from "mime-types";
import type { Event, ContentPart, InlineMediaContentPart } from "../core/types.js";
import type { StoredEvent } from "../context-window/system-snapshot.js";
import { getPathManager } from "../fs/path-manager.js";
import { parseEvents } from "./event-store.js";
import { scheduleRender } from "./xml-renderer.js";
import { AsyncLedgerWriter, appendLine, writeMediaFile } from "./async-ledger-writer.js";
import {
  writeActiveShardId,
} from "./ledger-pointer.js";

const MAX_SHARD_BYTES = 5 * 1024 * 1024;
const SIZE_CHECK_INTERVAL = 20;

/**
 * EventLedger — pure I/O layer for one agent's sharded event log.
 *
 * NOT exported from the package — only AgentLedger uses it internally.
 * All external access goes through AgentLedger's public API.
 */
export class EventLedger {
  readonly agentId: string;
  /** Owning session id. null = pre-session legacy bucket (path resolves to
   *  agent-ledgers/<agentId>/ for back-compat). New code always passes a sid. */
  readonly sessionId: string | null;
  private _activeShardId: string | null = null;
  private _currentShard = 1;
  private _appendCount = 0;
  private _rotating = false;
  private _switchLock: Promise<void> = Promise.resolve();
  /** Per-agent serial async writer — keeps appends off the event loop while
   *  preserving strict on-disk ordering (a ledger is a sequential log). */
  private readonly _writer: AsyncLedgerWriter;

  constructor(agentId: string, sessionId: string | null = null) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this._writer = new AsyncLedgerWriter(sessionId ? `${agentId}@${sessionId}` : agentId);
    this._loadActiveShard();
    if (this._activeShardId) {
      this._initShardIndex();
    }
  }

  // ─── Writer lifecycle ──────────────────────────────────────────────────

  /** Await all pending async appends (used on shutdown / before reads that
   *  must reflect every enqueued event). */
  async flush(): Promise<void> {
    await this._writer.flush();
  }

  /** Flush remaining writes then unregister the writer. */
  async dispose(): Promise<void> {
    await this._writer.flush();
    this._writer.dispose();
  }

  // ─── Shard lifecycle ───────────────────────────────────────────────────

  get activeShardId(): string | null {
    return this._activeShardId;
  }

  async rollShard(shardId?: string): Promise<string> {
    return this._withSwitchLock(async () => {
      const sid = shardId ?? `shard_${Date.now()}`;
      const dir = this._shardDir(sid);
      mkdirSync(dir, { recursive: true });
      await writeActiveShardId(getPathManager(), this.agentId, sid, this.sessionId);
      this._activeShardId = sid;
      this._currentShard = 1;
      this._appendCount = 0;
      return sid;
    });
  }

  async switchShard(shardId: string): Promise<void> {
    await this._withSwitchLock(async () => {
      const dir = this._shardDir(shardId);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await writeActiveShardId(getPathManager(), this.agentId, shardId, this.sessionId);
      this._activeShardId = shardId;
      this._initShardIndex();
    });
  }

  reloadPointer(): void {
    this._loadActiveShard();
    if (this._activeShardId) {
      this._initShardIndex();
    }
  }

  listShards(): string[] {
    const agentLedgerRoot = this._agentLedgerDir();
    try {
      return readdirSync(agentLedgerRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  // ─── Shard info ─────────────────────────────────────────────────────────

  private _agentLedgerDir(): string {
    return getPathManager().team().ledgersFor(this.agentId, this.sessionId);
  }

  private _shardDir(shardId: string): string {
    return join(this._agentLedgerDir(), shardId);
  }

  private _activeDir(): string {
    if (!this._activeShardId) {
      throw new Error(`EventLedger(${this.agentId}): no active shard`);
    }
    return this._shardDir(this._activeShardId);
  }

  private _shardPath(n: number): string {
    return join(this._activeDir(), `events-${n}.jsonl`);
  }

  private currentShardPath(): string {
    return this._shardPath(this._currentShard);
  }

  /** Full paths to all event-N.jsonl files in the active shard, sorted by index. */
  private listShardFilePaths(): string[] {
    if (!this._activeShardId) return [];
    const dir = this._activeDir();
    try {
      return this._sortedShardNames(dir).map(f => join(dir, f));
    } catch {
      return [];
    }
  }

  /** Number of event-N.jsonl files in the active shard (= max shard index). */
  get shardCount(): number {
    return this._currentShard;
  }

  // ─── Event I/O ─────────────────────────────────────────────────────────

  /**
   * Persist a bus Event to the active shard file.
   *
   * Ledger owner is implied by file path (`agent-ledgers/{this.agentId}/...`)
   * — we don't stamp `agent` onto each event. `emitterId` is captured by
   * EventBus at emit() time and preserved verbatim so downstream renderers
   * can identify the real emitter without reverse-engineering `event.source`.
   */
  append(event: Event, emitterId?: string): void {
    if (!this._activeShardId) return;
    const stored: StoredEvent = { ...event, emitterId };
    // Resolve the target paths synchronously (depend on _activeShardId /
    // _currentShard which mutate on the event-loop thread) so the queued task
    // captures a stable destination even if a rotation happens afterwards.
    const dir = this._activeDir();
    const filePath = this.currentShardPath();
    // Enqueue ONE serial task: externalize inline media (async writeFile) then
    // append the JSON line. Because the writer runs tasks strictly in enqueue
    // order, on-disk event order == call order. enqueue returns immediately —
    // the gateway event loop is no longer blocked on appendFileSync per frame.
    this._writer.enqueueTask(async () => {
      await this._externalizeInlineMedia(stored, dir);
      await appendLine(dir, filePath, JSON.stringify(stored) + "\n");
    });
    scheduleRender(this.agentId, this.sessionId);

    this._appendCount++;
    if (this._appendCount >= SIZE_CHECK_INTERVAL) {
      this._appendCount = 0;
      void this._maybeRotate();
    }
  }

  async readAllEvents(): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    for (const path of this.listShardFilePaths()) {
      try {
        const raw = await readFile(path, "utf-8");
        all.push(...parseEvents(raw));
      } catch { /* skip unreadable */ }
    }
    return all;
  }

  /**
   * Read shard files from the tail (most recent first), prepending each batch
   * until `isEnough(accumulated)` returns true or all files are exhausted.
   */
  async readFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> {
    const paths = this.listShardFilePaths();
    const result: StoredEvent[] = [];
    for (let i = paths.length - 1; i >= 0; i--) {
      try {
        const raw = await readFile(paths[i], "utf-8");
        const batch = parseEvents(raw);
        result.unshift(...batch);
        if (isEnough(result)) break;
      } catch { /* skip unreadable */ }
    }
    return result;
  }

  // ─── Init helpers ──────────────────────────────────────────────────────

  private _loadActiveShard(): void {
    try {
      const pointerPath = join(this._agentLedgerDir(), "ledger.json");
      const raw = readFileSync(pointerPath, "utf-8");
      const data = JSON.parse(raw) as { activeShardId?: string };
      this._activeShardId = data.activeShardId ?? null;
    } catch {
      this._activeShardId = null;
    }
  }

  private _initShardIndex(): void {
    if (!this._activeShardId) return;
    const dir = this._activeDir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* already exists */ }

    let max = 0;
    try {
      for (const f of readdirSync(dir)) {
        const m = f.match(/^events-(\d+)\.jsonl$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch { /* empty dir */ }

    this._currentShard = max > 0 ? max : 1;
  }

  private async _maybeRotate(): Promise<void> {
    if (this._rotating) return;
    this._rotating = true;
    try {
      const size = (await statAsync(this.currentShardPath())).size;
      if (size < MAX_SHARD_BYTES) return;
      this._currentShard++;
      console.log(`[ledger] ${this.agentId}: shard rotated to events-${this._currentShard}.jsonl`);
    } catch {
      // file may not be flushed yet / unreadable — skip this rotation check
    } finally {
      this._rotating = false;
    }
  }

  // ─── Media externalization ─────────────────────────────────────────────

  /**
   * Recursively walk `stored.payload` and replace any inline media ContentParts
   * ({type:"image"|"video"|"audio", data, mimeType}) with *_file path
   * references, writing the binary data to {activeDir}/medias/{uuid}.{ext}.
   * Mutates `stored` in place — called before JSON.stringify in append().
   *
   * Uses generic recursive traversal so that new ContentPart[] nesting
   * locations in future event payloads are automatically covered.
   */
  private async _externalizeInlineMedia(stored: StoredEvent, dir: string): Promise<void> {
    if (!stored.payload || typeof stored.payload !== "object") return;
    await this._walkAndExternalize(stored.payload as Record<string, unknown>, dir);
  }

  /** Recurse into objects/arrays; replace inline media parts in-place. */
  private async _walkAndExternalize(node: unknown, dir: string): Promise<void> {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (this._isInlineMedia(node[i])) {
          node[i] = await this._persistInlineMedia(node[i] as InlineMediaContentPart, dir);
        } else {
          await this._walkAndExternalize(node[i], dir);
        }
      }
      return;
    }
    for (const val of Object.values(node)) {
      await this._walkAndExternalize(val, dir);
    }
  }

  /**
   * Runtime type guard for inline media — stricter than `isInlineMediaContentPart`
   * because it operates on arbitrary `unknown` values during recursive traversal.
   * Checks `type`, `data` (string), and `mimeType` (string) to avoid false positives.
   */
  private _isInlineMedia(val: unknown): val is InlineMediaContentPart {
    if (!val || typeof val !== "object") return false;
    const obj = val as Record<string, unknown>;
    return (obj.type === "image" || obj.type === "video" || obj.type === "audio")
      && typeof obj.data === "string"
      && typeof obj.mimeType === "string";
  }

  private async _persistInlineMedia(part: InlineMediaContentPart, activeDir: string): Promise<ContentPart> {
    try {
      const mediaDir = join(activeDir, "medias");
      const ext = mimeExtension(part.mimeType) || "bin";
      const stem = part.name ? part.name.replace(/\.[^.]+$/, "") : randomUUID();
      const filePath = join(mediaDir, `${stem}_${randomUUID().slice(0, 8)}.${ext}`);
      await writeMediaFile(mediaDir, filePath, Buffer.from(part.data, "base64"));
      const fileType = `${part.type}_file` as "image_file" | "audio_file" | "video_file";
      return { type: fileType, path: filePath, mimeType: part.mimeType, inContainer: false };
    } catch {
      return part; // fallback: keep inline if write fails
    }
  }

  private _sortedShardNames(dir: string): string[] {
    return readdirSync(dir)
      .filter(f => /^events-\d+\.jsonl$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      });
  }

  private _withSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._switchLock;
    let resolve!: () => void;
    this._switchLock = new Promise<void>(r => { resolve = r; });
    return prev.then(fn).finally(resolve);
  }
}
