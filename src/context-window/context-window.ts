// @desc ContextWindow — resolve model-visible message history from agent-ledger events

import type { AgentLedgerAPI } from "../session/types.js";
import type { StoredEvent, SnapshotEntry } from "./system-snapshot.js";
import { replaySystemSnapshot } from "./system-snapshot.js";
import { eventsToMessages } from "./history-pipeline.js";
import { normalizeHistory } from "./tool-normalizer.js";
import { sanitizeMedia } from "./media-normalizer.js";
import { microCompact, trackUserInput, getLastUserInputAt, type MicroCompactConfig } from "./micro-compaction.js";
import type { LLMMessage } from "../llm/types.js";
import { normalizeContent } from "../message/modality.js";

// ─── Boundary types ─────────────────────────────────────────────────────────

export type BoundaryHit =
  | { type: "compact"; idx: number; summary: string; keepCount: number }
  | { type: "partial"; idx: number; summary: string; segmentId: string;
      summarizedRange: { fromTs: number; toTs: number } };

/**
 * Scan events backwards to collect all boundaries.
 * - partial_boundary: collected, search continues
 * - compact_boundary: collected, search stops (everything before it is replaced)
 *
 * Returns boundaries in event-stream order (oldest first).
 * Returns null if no boundaries found.
 */
export function locateBoundaries(events: StoredEvent[]): {
  boundaries: BoundaryHit[];
  anchorIdx: number;
  hasCompleteBoundary: boolean;
} | null {
  const hits: BoundaryHit[] = [];
  let anchorIdx = events.length;
  let hasCompleteBoundary = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "partial_boundary") {
      const p = ev.payload ?? {};
      hits.push({
        type: "partial",
        idx: i,
        summary: (p.summary as string) ?? "",
        segmentId: (p.segmentId as string) ?? "",
        summarizedRange: (p.summarizedRange as { fromTs: number; toTs: number })
          ?? { fromTs: 0, toTs: 0 },
      });
      anchorIdx = i;
    } else if (ev.type === "compact_boundary") {
      const p = ev.payload ?? {};
      hits.push({
        type: "compact",
        idx: i,
        summary: (p.summary as string) ?? "",
        keepCount: (p.keepCount as number) ?? 0,
      });
      anchorIdx = i;
      hasCompleteBoundary = true;
      break;
    }
  }

  if (hits.length === 0) return null;
  hits.reverse();
  return { boundaries: hits, anchorIdx, hasCompleteBoundary };
}

/**
 * Predicate for tail-first shard loading.
 * compact_boundary terminates search; partial_boundary does NOT.
 */
function hasEnoughContext(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact_boundary") return true;
  }
  return false;
}

/**
 * Slice events to the model-visible window.
 *
 * compact_boundary: everything before it is discarded (except keepCount msgs).
 * Each partial_boundary: events within its summarizedRange are dropped.
 * All boundary summaries become synthetic user messages at the top.
 * Events after the last boundary (protection zone) pass through unchanged.
 */
function applyCompactTruncation(events: StoredEvent[]): StoredEvent[] {
  const loc = locateBoundaries(events);
  if (!loc) return events;

  const { boundaries, hasCompleteBoundary } = loc;
  const summaryEvents: StoredEvent[] = [];

  // dropBeforeIdx: everything before this index is discarded (compact_boundary)
  let dropBeforeIdx = 0;

  // keepSet: indices restored by compact keepCount (exceptions to dropBeforeIdx)
  const keepSet = new Set<number>();

  // droppedByPartial: indices covered by partial_boundary ranges
  const droppedByPartial = new Set<number>();

  for (let bi = 0; bi < boundaries.length; bi++) {
    const b = boundaries[bi];

    summaryEvents.push({
      type: "inbound_message",
      ts: events[b.idx].ts,
      source: "system",
      payload: {
        llmMessage: {
          role: "user" as const,
          content: normalizeContent(
            `[Session Summary — Earlier context was compacted]\n\n${b.summary}\n\n` +
            `Recent messages after this summary are preserved verbatim.\n` +
            `Continue from where you left off. Do NOT re-do work listed under "Completed Work" above. ` +
            `Do NOT ask the user to recap — use sections 7-9 of the summary to understand current state.`,
          ),
          ts: events[b.idx].ts,
        },
      },
    });

    if (b.type === "compact") {
      dropBeforeIdx = b.idx + 1;

      if (b.keepCount > 0) {
        let found = 0;
        for (let i = b.idx - 1; i >= 0; i--) {
          if (events[i].payload?.llmMessage) {
            found++;
            keepSet.add(i);
            if (found >= b.keepCount) break;
          }
        }
      }
    } else {
      const scanStart = bi > 0 ? boundaries[bi - 1].idx + 1 : dropBeforeIdx;
      const isLast = bi === boundaries.length - 1;

      if (isLast) {
        // Last boundary: use toTs to precisely keep the protection zone.
        // Events with ts < toTs were summarized → drop.
        // Events with ts >= toTs are the protection zone → keep.
        const cutoff = b.summarizedRange.toTs;
        for (let i = scanStart; i < b.idx; i++) {
          if (events[i].ts < cutoff) {
            droppedByPartial.add(i);
          }
        }
      } else {
        // Older boundaries: drop everything — old protection zones are stale.
        for (let i = scanStart; i < b.idx; i++) {
          droppedByPartial.add(i);
        }
      }
    }
  }

  const lastBoundaryIdx = boundaries[boundaries.length - 1].idx;
  const result: StoredEvent[] = [];

  result.push(...summaryEvents);

  // Kept messages before compact (keepCount exceptions)
  if (hasCompleteBoundary && keepSet.size > 0) {
    for (const i of keepSet) result.push(events[i]);
  }

  // Events between boundaries not covered by partial ranges
  for (let i = dropBeforeIdx; i < lastBoundaryIdx; i++) {
    if (droppedByPartial.has(i)) continue;
    if (events[i].type === "compact_boundary" || events[i].type === "partial_boundary") continue;
    result.push(events[i]);
  }

  // Events after the last boundary (protection zone)
  for (let i = lastBoundaryIdx + 1; i < events.length; i++) {
    result.push(events[i]);
  }

  return result;
}

/**
 * ContextWindow — resolves model-visible conversation history.
 *
 * Uses tail-first shard loading: reads shards from the most recent backwards,
 * stopping as soon as enough context is found (compact_boundary).
 * Falls back to reading all shards when no compact_boundary exists.
 */
export class ContextWindow {
  constructor(
    private readonly agentId: string,
    private readonly ledger: AgentLedgerAPI,
    private readonly teamBoard?: { get(agentId: string, key: string): unknown; set(agentId: string, key: string, value: unknown, opts: { persist: boolean }): void },
  ) {}

  /** Scan events for user_input and persist the idle anchor to teamboard. */
  trackEvents(events: ReadonlyArray<{ type: string; ts: number }>): void {
    if (this.teamBoard) trackUserInput(events, this.teamBoard, this.agentId);
  }

  async buildPrompt(options: MicroCompactConfig = {}): Promise<LLMMessage[]> {
    const windowEvents = await this.readWindowEvents();
    const msgs = eventsToMessages(windowEvents);
    const sanitized = await sanitizeMedia(normalizeHistory(msgs).messages);
    const resolved = this.teamBoard
      ? { ...options, lastUserInputAt: options.lastUserInputAt ?? getLastUserInputAt(this.teamBoard, this.agentId) }
      : options;
    return microCompact(sanitized, resolved);
  }

  /**
   * Returns raw events without compact truncation applied.
   * Used by partialCompact to inspect existing boundaries and determine
   * the compression segment.
   */
  async getWindowEventsRaw(): Promise<StoredEvent[]> {
    return this.ledger.readEventsFromTail(hasEnoughContext);
  }

  async buildSystemSnapshot(): Promise<Map<string, SnapshotEntry>> {
    const allEvents = await this.ledger.readEvents();
    return replaySystemSnapshot(allEvents);
  }

  private async readWindowEvents(): Promise<StoredEvent[]> {
    const events = await this.ledger.readEventsFromTail(hasEnoughContext);
    return applyCompactTruncation(events);
  }
}
