// @desc AgentLedger — per-agent event-ledger facade (owns EventLedger internally)
//
// One AgentLedger lives inside one BaseAgent for that agent's lifetime.
// A daemon-level "Session" (the user-facing chat session) owns a tree of
// agents, and each of those agents owns one AgentLedger. AgentLedger is
// strictly per-agent storage — it does NOT model "switching sessions"
// at the conversation level. The shard methods below (rollShard /
// switchShard / listShards) are about file-rotation inside the agent's
// own ledger, not about chat sessions.

import { EventLedger } from "./event-ledger.js";
import { ledgerPointerPath } from "./ledger-pointer.js";
import { scheduleRender } from "./xml-renderer.js";
import { getPathManager } from "../fs/path-manager.js";
import type { EventBusAPI, FSWatcherAPI, WatchRegistration, Event } from "../core/types.js";
import type { StoredEvent } from "../context-window/system-snapshot.js";
import { STREAM_PREFIX, Hook } from "../hooks/types.js";
import { recoverLedger } from "./ledger-recovery.js";

/**
 * AgentLedger — the single public entry point for one agent's event storage.
 *
 * Responsibilities:
 *   1. Owns EventLedger internally (never exposed)
 *   2. Observes EventBus and routes events to EventLedger for persistence
 *   3. Manages internal shard lifecycle: roll / switch / list
 *   4. Watches ledger.json via FSWatcher for external pointer changes
 *   5. Exposes read-only API for event data access (with optional truncation)
 *
 * Held by BaseAgent — all agent types get an AgentLedger.
 */
export class AgentLedger {
  private readonly _ledger: EventLedger;
  private readonly agentId: string;
  private readonly eventBus: EventBusAPI;
  private readonly sessionId: string | null;
  private _pointerWatch: WatchRegistration | null = null;
  private _busUnsub: (() => void) | null = null;

  constructor(
    agentId: string,
    eventBus: EventBusAPI,
    fsWatcher?: FSWatcherAPI,
    sessionId: string | null = null,
  ) {
    this.agentId = agentId;
    this.eventBus = eventBus;
    this.sessionId = sessionId;
    this._ledger = new EventLedger(agentId, sessionId);

    this._bindEventBus();

    if (fsWatcher) {
      this._watchPointer(fsWatcher);
    }
  }

  // ─── EventBus routing ─────────────────────────────────────────────────

  private _bindEventBus(): void {
    const agentId = this.agentId;
    this._busUnsub = this.eventBus.observe((event: Event, emitterId?: string) => {
      if (emitterId !== agentId && event.to !== agentId) return;
      if (event.type.startsWith(STREAM_PREFIX)) return;
      this._ledger.append(event, emitterId);
    });
  }

  // ─── Pointer fs-watch ─────────────────────────────────────────────────

  private _watchPointer(watcher: FSWatcherAPI): void {
    if (this._pointerWatch) return;
    const absPath = ledgerPointerPath(getPathManager(), this.agentId, this.sessionId);
    this._pointerWatch = watcher.watchFile(absPath, () => {
      const prev = this._ledger.activeShardId;
      this._ledger.reloadPointer();
      const next = this._ledger.activeShardId;
      if (prev !== next) {
        console.log(`[ledger] ${this.agentId}: pointer reloaded ${prev} → ${next}`);
        this.eventBus.hook(Hook.LedgerShardChange, {
          previousShardId: prev, shardId: next, reason: "pointer_reload",
        });
        scheduleRender(this.agentId, this.sessionId);
      }
    }, { debounceMs: 200, ownerId: this.agentId });
  }

  // ─── Shard lifecycle ──────────────────────────────────────────────────

  activeShardId(): string | null {
    return this._ledger.activeShardId;
  }

  get hasLedger(): boolean {
    return this._ledger.shardCount > 0;
  }

  async rollShard(): Promise<string> {
    const prev = this._ledger.activeShardId;
    const sid = await this._ledger.rollShard();
    this.eventBus.hook(Hook.LedgerShardChange, {
      previousShardId: prev, shardId: sid, reason: "created",
    });
    scheduleRender(this.agentId, this.sessionId);
    return sid;
  }

  async switchShard(shardId: string): Promise<void> {
    const prev = this._ledger.activeShardId;
    await this._ledger.switchShard(shardId);
    this.eventBus.hook(Hook.LedgerShardChange, {
      previousShardId: prev, shardId, reason: "switched",
    });
    scheduleRender(this.agentId, this.sessionId);
  }

  listShards(): string[] {
    return this._ledger.listShards();
  }

  async ensureActive(): Promise<void> {
    if (!this.activeShardId()) {
      await this.rollShard();
    }
    await recoverLedger(
      this.agentId,
      () => this.readEventsFromTail(() => true),
      // Stamp emitterId so recovery-backfilled events match the live path shape.
      (ev) => this._ledger.append(ev, this.agentId),
    );
  }

  // ─── Event data access (read-only) ────────────────────────────────────

  /**
   * Read all events from the active shard, optionally applying a truncation function.
   * The truncation function receives the full event array and returns the visible subset.
   */
  async readEvents(truncateFn?: (events: StoredEvent[]) => StoredEvent[]): Promise<StoredEvent[]> {
    // Drain pending async appends so the read reflects every enqueued event
    // (writes are now async — see async-ledger-writer).
    await this._ledger.flush();
    const all = await this._ledger.readAllEvents();
    return truncateFn ? truncateFn(all) : all;
  }

  /**
   * Read shards from the tail (most recent first) until `isEnough` returns true.
   * Much cheaper than `readEvents` when only recent context is needed (e.g. after compaction).
   */
  async readEventsFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> {
    await this._ledger.flush();
    return this._ledger.readFromTail(isEnough);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  destroy(): void {
    this._busUnsub?.();
    this._busUnsub = null;
    this._pointerWatch?.dispose();
    this._pointerWatch = null;
    // Flush + unregister the async writer (best-effort; don't block destroy).
    void this._ledger.dispose();
  }
}
