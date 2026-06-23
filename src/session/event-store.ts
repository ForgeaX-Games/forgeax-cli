import type { StoredEvent } from "../context-window/system-snapshot.js";

export type { StoredEvent };

/** Parse raw JSONL text into StoredEvent[]. */
export function parseEvents(raw: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return events;
}
