/**
 * Minimal agent-ledger surface exposed to tools via AgentContext.
 * Deliberately narrow — tools should not reach into full ledger internals.
 */

import type { StoredEvent } from "../context-window/system-snapshot.js";

export interface AgentLedgerAPI {
  /** True if any event shards exist for the active ledger. */
  readonly hasLedger: boolean;
  /** Current active shard ID. */
  activeShardId(): string | null;
  /** Roll a new shard and switch to it. */
  rollShard(): Promise<string>;
  /** Switch to an existing shard by ID. */
  switchShard(shardId: string): Promise<void>;
  /** List available shard IDs. */
  listShards(): string[];

  // ─── Event data access ────────────────────────────────────

  /** Read all events from the active shard, with optional custom truncation. */
  readEvents(truncateFn?: (events: StoredEvent[]) => StoredEvent[]): Promise<StoredEvent[]>;
  /** Read shards from the tail until `isEnough` returns true. Avoids loading old shards. */
  readEventsFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]>;
}
