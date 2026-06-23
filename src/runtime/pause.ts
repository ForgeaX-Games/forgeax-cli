/**
 * Doc 07 §TopBar Pause — backend half.
 *
 * Spec: a single global "Pause AI" toggle that halts AI-initiated tool calls
 * (and AI-initiated skill runs) without killing in-flight handlers. UI lands
 * later; this module gives the host a callable surface + bus events so:
 *
 *   1. POST /api/runtime/pause { paused: boolean } → toggle the flag.
 *   2. Anyone (driver, tool gate, skill runner) calls `isPaused()` on the
 *      AI request path and short-circuits with `code:'paused'`.
 *   3. The bus emits `runtime.paused` / `runtime.resumed` so connected UIs
 *      flip their TopBar indicator without polling.
 *
 * Scope rules: only `caller.kind === 'ai'` is paused. User/CLI/workbench
 * actions remain live — the design intent is "freeze the agent, not the
 * user". Skills triggered from a paused AI turn inherit the block by
 * propagating the caller kind.
 */
import { getEventBus } from '../events/bus';

let _paused = false;

export function isPaused(): boolean {
  return _paused;
}

export interface PauseState {
  paused: boolean;
  changedAt: number;
}

let _changedAt = 0;

export function getPauseState(): PauseState {
  return { paused: _paused, changedAt: _changedAt };
}

/** Set or toggle the pause flag. Idempotent: setting to the current value
 *  is a no-op (no event fired). Returns the new state. */
export function setPaused(next: boolean, reason?: string): PauseState {
  if (next === _paused) return { paused: _paused, changedAt: _changedAt };
  _paused = next;
  _changedAt = Date.now();
  const topic = next ? 'runtime.paused' : 'runtime.resumed';
  getEventBus().emit(topic, { reason: reason ?? null, at: _changedAt });
  return { paused: _paused, changedAt: _changedAt };
}

export function _resetPauseForTests(): void {
  _paused = false;
  _changedAt = 0;
}
