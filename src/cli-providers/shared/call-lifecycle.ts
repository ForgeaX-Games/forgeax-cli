/**
 * call-lifecycle -- Doc 05 section 7 driver init/cancel/timeout glue for the
 * legacy `CliProvider` interface (the new `Driver` contract in
 * @forgeax/agent-runtime already ships its own helpers; this is the bridge
 * for /api/cli/* until the swap finishes).
 *
 * Each in-flight chat call is keyed by `callId` and tracked in a process-wide
 * map per provider. The provider's `cancel(callId)` aborts the corresponding
 * AbortController; per-call `timeoutMs` schedules an automatic abort that
 * surfaces a structured `{ type: 'error', code: 'driver-timeout' }` terminal
 * event followed by a `done` with `stopReason: 'cancelled'`.
 *
 * Cancelled calls (whether by `cancel(callId)`, a parent AbortSignal, or
 * timeout) emit `{ type: 'done', stopReason: 'cancelled', code }` so callers
 * see a single terminal frame regardless of who pulled the plug.
 */
import type { ChatEvent, ChatRequest } from '../types';

export interface CallTracker {
  /** Get the AbortController for an in-flight call. */
  get(callId: string): AbortController | undefined;
  /** Register an AbortController under callId. Returns a release fn. */
  register(callId: string, ctrl: AbortController): () => void;
  /** Cancel an in-flight call by id. Idempotent for unknown ids. */
  cancel(callId: string): Promise<void>;
  /** Snapshot count -- mostly for tests. */
  size(): number;
}

export function createCallTracker(): CallTracker {
  const calls = new Map<string, AbortController>();
  return {
    get(callId) {
      return calls.get(callId);
    },
    register(callId, ctrl) {
      calls.set(callId, ctrl);
      return () => {
        if (calls.get(callId) === ctrl) calls.delete(callId);
      };
    },
    async cancel(callId) {
      const ctrl = calls.get(callId);
      if (!ctrl) return;
      try {
        ctrl.abort();
      } catch {
        // best-effort
      }
    },
    size() {
      return calls.size;
    },
  };
}

/**
 * Wrap a provider chat-event iterator with per-call lifecycle:
 *  - registers a per-call AbortController with the tracker, linked to the
 *    parent signal forwarded by the route
 *  - schedules `req.timeoutMs` if set, fires `driver-timeout` on expiry
 *  - guarantees the iterator ends with a single terminal frame; if the inner
 *    iterator stops without one (e.g. on abort), synthesises `done`
 *
 * Producers stay simple: they just yield events as usual and listen on the
 * `signal` returned in `attach()` to bail out of any blocking work.
 *
 * The wrapper does NOT swallow inner-iterator exceptions; producers should
 * still translate fetch/spawn errors into `{ type: 'error', code }` events
 * before the wrapper sees them.
 */
export interface LifecycleHandle {
  /** AbortSignal the producer should listen on. Aborts on cancel/timeout/
   *  parent abort. */
  readonly signal: AbortSignal;
  /** Why we aborted, if we did. Null while still running. Set before the
   *  terminal frame is yielded so the wrapper can stamp the right code. */
  reason(): 'cancelled' | 'driver-timeout' | null;
}

export async function* withCallLifecycle(
  req: ChatRequest,
  parentSignal: AbortSignal,
  tracker: CallTracker,
  body: (h: LifecycleHandle) => AsyncIterable<ChatEvent>,
): AsyncIterable<ChatEvent> {
  const callId = req.callId;
  const ctrl = new AbortController();
  let abortReason: 'cancelled' | 'driver-timeout' | null = null;

  const onParentAbort = () => {
    if (!abortReason) abortReason = 'cancelled';
    try { ctrl.abort(); } catch { /* ignore */ }
  };
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener('abort', onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (typeof req.timeoutMs === 'number' && req.timeoutMs > 0) {
    timer = setTimeout(() => {
      abortReason = 'driver-timeout';
      try { ctrl.abort(); } catch { /* ignore */ }
    }, req.timeoutMs);
  }

  let releaseCall: (() => void) | null = null;
  if (callId) releaseCall = tracker.register(callId, ctrl);

  // Override the cancel path: if cancel() ran via tracker on this same ctrl,
  // mark abortReason so the terminal frame is correctly tagged. We can't
  // distinguish `tracker.cancel(callId)` from a direct ctrl.abort(), but the
  // tracker is the only path callers should use, so observing ctrl.abort
  // without a prior parent/timeout reason means cancel() fired.
  ctrl.signal.addEventListener('abort', () => {
    if (!abortReason) abortReason = 'cancelled';
  }, { once: true });

  let terminalEmitted = false;
  try {
    for await (const ev of body({ signal: ctrl.signal, reason: () => abortReason })) {
      if (ev.type === 'done' || ev.type === 'error') {
        terminalEmitted = true;
        yield ev;
        // After a terminal, drain remaining inner events but don't forward.
        return;
      }
      yield ev;
    }
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
    if (releaseCall) releaseCall();
  }

  // Producer ended without a terminal frame. If we aborted, synthesise the
  // structured terminal so callers always see exactly one closing event.
  // The route's SSE loop closes on the first `done`/`error` frame, so we
  // pack the failure code into a single terminal rather than emitting an
  // `error` followed by `done` (the route would only forward the first).
  if (!terminalEmitted) {
    if (abortReason === 'driver-timeout') {
      yield {
        type: 'error',
        message: `driver timed out after ${req.timeoutMs}ms`,
        code: 'driver-timeout',
      };
    } else if (abortReason === 'cancelled') {
      yield { type: 'done', stopReason: 'cancelled', code: 'cancelled' };
    } else {
      // Producer ran to completion without yielding a terminal -- legacy
      // contract expected callers to detect EOF on their own. Synthesise a
      // neutral done so /api/cli SSE always closes cleanly.
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
}
