/** Event replay — replays StoredEvents through TurnAccumulator into CompletedTurn[]. */
import type { StoredEvent, CompletedTurn } from "./types.js";
import { TurnAccumulator } from "./turn-accumulator.js";

export function replayEvents(events: StoredEvent[], viewerId?: string): CompletedTurn[] {
  const turns: CompletedTurn[] = [];
  const acc = new TurnAccumulator({
    onTurn: (turn) => turns.push(turn),
  }, viewerId);
  for (const event of events) {
    acc.feed(event);
  }
  acc.flush();
  return turns;
}
