/** system-snapshot —— pure functions for replaying & diffing system prompt state.
 *
 *  与 agenteam ref 1:1（StoredEvent 类型来源换成 ledger/types 而不是本地副本）：
 *  - replaySystemSnapshot(events) → Map<blockName, SnapshotEntry>
 *  - diffSystemBlocks(prev, current) → SystemDelta | null
 *
 *  Zero I/O / zero side-effects，agent 层 / SessionManager / xml renderer 共享。
 *  支持三种历史 payload 格式：
 *    1) `{ changed: SystemBlock[], removed?: string[] }` —— 当前 delta 格式
 *    2) `{ blocks: SystemBlock[] }` —— v0.2 全量
 *    3) `{ content: string }` —— v0.1 legacy（写到 __legacy__ key） */

import type { SystemBlock } from "../llm/types";
import type { StoredEvent } from "../ledger/types";

export interface SnapshotEntry {
  text: string;
  priority: number;
  /** Cache hint replayed from the source SystemBlock。`undefined` 当 dynamic 处理。 */
  cacheHint?: "stable" | "dynamic";
}

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

    // COMPAT:v0.2 — full blocks array
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

    // COMPAT:v0.1 — legacy string
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

/** Diff `current` blocks 对照 `previous` snapshot；无变化返回 null。
 *  `previous` map 会被 mutate（caller 视为可弃）。 */
export function diffSystemBlocks(
  previous: Map<string, SnapshotEntry>,
  current: SystemBlock[],
): SystemDelta | null {
  const changed: SystemBlock[] = [];
  const currentNames = new Set<string>();

  for (const block of current) {
    currentNames.add(block.name);
    if (previous.get(block.name)?.text !== block.text) changed.push(block);
  }

  const removed: string[] = [];
  for (const id of previous.keys()) {
    if (!currentNames.has(id)) removed.push(id);
  }

  return changed.length > 0 || removed.length > 0
    ? { changed, removed }
    : null;
}
