// @desc Global headless event log — captures events with no emitterId and no event.to

import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Event } from "../core/types.js";
import { STREAM_PREFIX } from "../hooks/types.js";

type EventBusObservable = {
  observe(handler: (event: Event, emitterId?: string) => void): () => void;
};

let _unsub: (() => void) | null = null;

/**
 * Start recording headless events (no emitterId, no event.to) to
 * `<sessionsRoot>/global-events.jsonl`.  Idempotent — subsequent calls are no-ops.
 */
export function initGlobalEventLog(sessionsRoot: string, eventBus: EventBusObservable): void {
  if (_unsub) return;

  const filePath = join(sessionsRoot, "global-events.jsonl");
  let dirEnsured = false;

  _unsub = eventBus.observe((event, emitterId) => {
    if (emitterId != null || event.to != null) return;
    if (event.type.startsWith(STREAM_PREFIX)) return;
    if (!dirEnsured) {
      mkdirSync(dirname(filePath), { recursive: true });
      dirEnsured = true;
    }
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
  });
}

export function stopGlobalEventLog(): void {
  _unsub?.();
  _unsub = null;
}
