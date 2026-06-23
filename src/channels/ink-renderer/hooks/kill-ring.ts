/**
 * Kill ring — circular buffer for cut/kill text operations (Ctrl+U/K/W/Y).
 * Zero React dependency; pure module-level state.
 */

const KILL_RING_MAX = 10;

const killRing: string[] = [];
let killRingIdx = -1;

export function pushKill(text: string): void {
  if (!text) return;
  killRing.push(text);
  if (killRing.length > KILL_RING_MAX) killRing.shift();
  killRingIdx = killRing.length - 1;
}

export function getLastKill(): string {
  return killRing.length > 0 ? killRing[killRingIdx]! : "";
}
