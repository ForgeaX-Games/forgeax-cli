// @desc Ledger recovery — seal incomplete turns + backfill missing inbound_message after crash

import type { Event } from "../core/types.js";
import type { StoredEvent } from "../context-window/system-snapshot.js";
import { eventToSessionMessage } from "../message/message-ingress.js";

/**
 * Recover ledger integrity after a crash/restart.
 * Scans the latest shard and:
 *  1. Seals any turnStart without a matching turnEnd.
 *  2. Backfills `inbound_message` for input events that were persisted
 *     but never processed (matched via `sourceTs`).
 */
export async function recoverLedger(
  agentId: string,
  readEvents: () => Promise<StoredEvent[]>,
  appendEvent: (event: Event) => void,
): Promise<void> {
  const events = await readEvents();

  // 1. Seal unpaired turn
  let lastTurnStart: number | null = null;
  let sealed = true;
  for (const ev of events) {
    if (ev.type === "hook:turnStart") {
      lastTurnStart = (ev.payload as Record<string, unknown>)?.turn as number ?? 0;
      sealed = false;
    } else if (ev.type === "hook:turnEnd") {
      sealed = true;
    }
  }
  if (!sealed && lastTurnStart !== null) {
    appendEvent({
      source: `agent:${agentId}`,
      type: "hook:turnEnd",
      payload: { turn: lastTurnStart, aborted: true, error: "ledger recovered — previous turn did not end cleanly" },
      ts: Date.now(),
    });
  }

  // 2. Backfill unprocessed inputs
  const processedTs = new Set<number>();
  for (const ev of events) {
    if (ev.type === "inbound_message") {
      const ts = (ev.payload as Record<string, unknown>)?.sourceTs as number | undefined;
      if (ts != null) processedTs.add(ts);
    }
  }

  let backfilled = 0;
  for (const ev of events) {
    if (ev.to !== agentId || processedTs.has(ev.ts)) continue;
    const llmMessage = eventToSessionMessage(ev as Event);
    if (!llmMessage) continue;
    appendEvent({
      source: ev.source ?? "user",
      type: "inbound_message",
      payload: { llmMessage, sourceTs: ev.ts, originalType: ev.type, recovered: true },
      ts: Date.now(),
    });
    backfilled++;
  }
  if (backfilled > 0) {
    console.log(`[ledger] ${agentId}: backfilled ${backfilled} unprocessed input(s)`);
  }
}
