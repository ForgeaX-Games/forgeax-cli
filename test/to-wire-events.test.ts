/**
 * G2 — golden wire test for `toWireEvents`.
 *
 * Feeds a FIXED set covering all 12 KernelEvent kinds (the supremum union from
 * `@forgeax/agent-runtime` contract.ts) through `toWireEvents` and asserts the
 * wire `ChatEvent` output + the field renames that the `default: never`
 * exhaustiveness guard CANNOT prove (it only proves `kind` coverage, not
 * payload fidelity — see contract.ts §1.2.1):
 *
 *   message.delta   → { type:'token', text }
 *   thinking.delta  → { type:'thinking', text }
 *   tool.call       → { type:'tool-call', callId, name, args }
 *   tool.call.delta → { type:'tool-call-delta', argumentsDelta }   (argsDelta → argumentsDelta)
 *   tool.result     → { type:'tool-result', callId, ok, result, error }
 *   turn.usage      → []  (folded into WireFoldState; cacheRead → cacheReadTokens,
 *                          cacheCreation → cacheCreationTokens) — emitted on done
 *   turn.done       → { type:'done', stopReason, cost, durationMs, usage }   (reason → stopReason)
 *   error           → { type:'error', message, code }
 *   stored-event    → { type:'stored-event', storedEvent }         (payload → storedEvent)
 *   x.delegation    → []  (DROPPED)
 *   x.file_activity → []  (DROPPED)
 *   x.perception    → []  (DROPPED)
 *
 * NOTE on the real signature: `toWireEvents(ev, st)` takes an external
 * `WireFoldState` and the `turn.usage` → `done.usage` fold is threaded through
 * `st` (wire has no standalone usage event). So the design-doc phrase "folded
 * into the subsequent done.usage" is realised by the CALLER threading the same
 * `st` across both events — asserted below.
 */
import { describe, it, expect } from 'bun:test';
import type { KernelEvent } from '@forgeax/agent-runtime';
import { toWireEvents, newWireFoldState } from '../src/kernel/to-wire-events';
import type { ChatEvent } from '../src/cli-providers/types';

/** Run a single event against a fresh fold-state (for the stateless kinds). */
function wire(ev: KernelEvent): ChatEvent[] {
  return toWireEvents(ev, newWireFoldState());
}

describe('toWireEvents — golden wire mapping (all 12 KernelEvent kinds)', () => {
  it('message.delta → token', () => {
    expect(wire({ kind: 'message.delta', role: 'assistant', text: 'hello' })).toEqual([
      { type: 'token', text: 'hello' },
    ]);
  });

  it('thinking.delta → thinking', () => {
    expect(wire({ kind: 'thinking.delta', text: 'pondering' })).toEqual([
      { type: 'thinking', text: 'pondering' },
    ]);
  });

  it('tool.call → tool-call', () => {
    expect(
      wire({ kind: 'tool.call', callId: 'c1', name: 'Read', args: { path: '/x' } }),
    ).toEqual([{ type: 'tool-call', callId: 'c1', name: 'Read', args: { path: '/x' } }]);
  });

  it('tool.call.delta → tool-call-delta (argsDelta → argumentsDelta)', () => {
    const out = wire({
      kind: 'tool.call.delta',
      callId: 'c1',
      name: 'Read',
      argsDelta: '{"pa',
    });
    expect(out).toEqual([
      { type: 'tool-call-delta', callId: 'c1', name: 'Read', argumentsDelta: '{"pa' },
    ]);
    // the rename is the whole point — the wire shape has NO `argsDelta` key
    expect(out[0]).not.toHaveProperty('argsDelta');
    expect(out[0]).toHaveProperty('argumentsDelta');
  });

  it('tool.result → tool-result (ok / result / error preserved)', () => {
    expect(
      wire({ kind: 'tool.result', callId: 'c1', ok: true, result: { bytes: 12 } }),
    ).toEqual([{ type: 'tool-result', callId: 'c1', ok: true, result: { bytes: 12 }, error: undefined }]);

    expect(
      wire({ kind: 'tool.result', callId: 'c2', ok: false, error: 'ENOENT' }),
    ).toEqual([{ type: 'tool-result', callId: 'c2', ok: false, result: undefined, error: 'ENOENT' }]);
  });

  it('turn.usage → [] (folded into WireFoldState, not emitted standalone)', () => {
    expect(
      wire({
        kind: 'turn.usage',
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 30,
        cacheCreation: 20,
        costUsd: 0.0123,
        durationMs: 4567,
      }),
    ).toEqual([]);
  });

  it('turn.done → done (reason → stopReason)', () => {
    expect(wire({ kind: 'turn.done', reason: 'stop' })).toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(wire({ kind: 'turn.done', reason: 'tool_use' })).toEqual([
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(wire({ kind: 'turn.done', reason: 'max_tokens' })).toEqual([
      { type: 'done', stopReason: 'max_tokens' },
    ]);
    // max_turns collapses onto the wire's max_tokens (wire has no max_turns)
    expect(wire({ kind: 'turn.done', reason: 'max_turns' })).toEqual([
      { type: 'done', stopReason: 'max_tokens' },
    ]);
    expect(wire({ kind: 'turn.done', reason: 'cancelled' })).toEqual([
      { type: 'done', stopReason: 'cancelled' },
    ]);
    // error has no distinct wire stopReason → maps to cancelled
    expect(wire({ kind: 'turn.done', reason: 'error' })).toEqual([
      { type: 'done', stopReason: 'cancelled' },
    ]);
  });

  it('turn.usage folds into the subsequent turn.done (cacheRead → cacheReadTokens, cacheCreation → cacheCreationTokens)', () => {
    const st = newWireFoldState();
    // usage arrives first, emits nothing
    expect(
      toWireEvents(
        {
          kind: 'turn.usage',
          inputTokens: 100,
          outputTokens: 50,
          cacheRead: 30,
          cacheCreation: 20,
          costUsd: 0.0123,
          durationMs: 4567,
        },
        st,
      ),
    ).toEqual([]);
    // done flushes the folded usage/cost/duration onto the wire `done` event
    expect(toWireEvents({ kind: 'turn.done', reason: 'stop' }, st)).toEqual([
      {
        type: 'done',
        stopReason: 'end_turn',
        cost: 0.0123,
        durationMs: 4567,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 30,
          cacheCreationTokens: 20,
        },
      },
    ]);
  });

  it('error → error (message + code)', () => {
    expect(
      wire({ kind: 'error', error: { code: 'kernel_unavailable', message: 'no kernel' } }),
    ).toEqual([{ type: 'error', message: 'no kernel', code: 'kernel_unavailable' }]);
  });

  it('stored-event → stored-event (payload → storedEvent)', () => {
    const out = wire({ kind: 'stored-event', payload: { foo: 'bar' } });
    expect(out).toEqual([{ type: 'stored-event', storedEvent: { foo: 'bar' } }]);
    expect(out[0]).not.toHaveProperty('payload');
    expect(out[0]).toHaveProperty('storedEvent');
  });

  it('x.delegation → [] (dropped, no wire representation)', () => {
    expect(
      wire({ kind: 'x.delegation', delegator: 'forge', agentId: 'iori', brief: 'pillar' }),
    ).toEqual([]);
  });

  it('x.file_activity → [] (dropped)', () => {
    expect(wire({ kind: 'x.file_activity', path: '/g/src/a.ts', op: 'write' })).toEqual([]);
  });

  it('x.perception → [] (dropped)', () => {
    expect(wire({ kind: 'x.perception', source: 'console', payload: { log: 'x' } })).toEqual([]);
  });
});
