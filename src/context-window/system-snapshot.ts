/**
 * system-snapshot.ts — Pure functions for replaying & diffing system prompt state.
 *
 * Zero I/O, zero side-effects. Shared by:
 *   - AgentLedger     (build snapshot from events.jsonl for diff)
 *   - conscious-agent (runtime diff before emit)
 *   - xml.ts          (render <system> block)
 */

import type { SystemBlock } from "../llm/types.js";

/** Local copy of StoredEvent (mirrors media-dir.ts; avoids reverse layering). */
export interface StoredEvent {
  type: string;
  ts: number;
  source?: string;
  to?: string;
  emitterId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotEntry {
  text: string;
  priority: number;
  /** Cache hint replayed from the source SystemBlock. May be undefined for
   *  legacy snapshots predating the cacheHint field — consumers should treat
   *  undefined as "dynamic" (matches prompt-pipeline default). */
  cacheHint?: "stable" | "dynamic";
}

/**
 * Replay all `hook:systemPrompt` delta events into a Map<blockName, SnapshotEntry>.
 *
 * Supports three payload formats (newest → oldest):
 *   1. `{ changed: SystemBlock[], removed?: string[] }` — current delta format
 *   2. `{ blocks: SystemBlock[] }` — COMPAT:v0.2 full-snapshot format
 *   3. `{ content: string }`       — COMPAT:v0.1 legacy string format
 */
export function replaySystemSnapshot(events: readonly StoredEvent[]): Map<string, SnapshotEntry> {
  const map = new Map<string, SnapshotEntry>();
  let insertSeq = 0;

  for (const ev of events) {
    if (ev.type !== "hook:systemPrompt") continue;

    const p = ev.payload;
    if (!p) continue;

    const changed = p.changed;
    if (Array.isArray(changed)) {
      for (const b of changed) {
        if (typeof b?.name === "string" && typeof b?.text === "string") {
          map.set(b.name, {
            text: b.text,
            priority: b.priority ?? insertSeq++,
            cacheHint: b.cacheHint,
          });
        }
      }
      const removed = p.removed;
      if (Array.isArray(removed)) {
        for (const name of removed) {
          if (typeof name === "string") map.delete(name);
        }
      }
      continue;
    }

    // COMPAT:v0.2-systemPrompt-blocks — full blocks array (pre-delta format)
    const blocks = p.blocks;
    if (Array.isArray(blocks)) {
      map.clear();
      insertSeq = 0;
      for (const b of blocks) {
        if (typeof b?.name === "string" && typeof b?.text === "string") {
          map.set(b.name, {
            text: b.text,
            priority: b.priority ?? insertSeq++,
            cacheHint: b.cacheHint,
          });
        }
      }
      continue;
    }

    // COMPAT:v0.1-systemPrompt-string — legacy string content
    const content = p.content;
    if (typeof content === "string") {
      map.clear();
      map.set("__legacy__", { text: content, priority: 0 });
    }
  }

  return map;
}

export interface SystemDelta {
  changed: SystemBlock[];
  removed: string[];
}

/**
 * Diff `current` blocks against a `previous` snapshot (typically from
 * `replaySystemSnapshot`). Returns the delta, or `null` if nothing changed.
 *
 * The `previous` map may be mutated — callers should treat it as disposable.
 */
export function diffSystemBlocks(
  previous: Map<string, SnapshotEntry>,
  current: SystemBlock[],
): SystemDelta | null {
  const changed: SystemBlock[] = [];
  const currentNames = new Set<string>();

  for (const block of current) {
    currentNames.add(block.name);
    if (previous.get(block.name)?.text !== block.text) {
      changed.push(block);
    }
  }

  const removed: string[] = [];
  for (const id of previous.keys()) {
    if (!currentNames.has(id)) {
      removed.push(id);
    }
  }

  return changed.length > 0 || removed.length > 0
    ? { changed, removed }
    : null;
}
