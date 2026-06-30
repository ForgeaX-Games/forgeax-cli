import { describe, test, expect } from 'bun:test';
import { adapt, createAdapterState } from '../src/observatory/event-adapter';
import type { StoredEvent } from '../src/ledger/types';

// Regression: forgeax-core carries the tool correlation id at top-level `callId`
// on BOTH hook:toolCall and hook:toolResult. The observatory adapter used to read
// only toolUseId/toolCallId/llmMessage.toolCallId → the result resolved to '' and
// the trajectory node never left "running" (e.g. ask_user stuck forever after the
// user answered). The adapter must now read `callId` so call ↔ result line up.

const ev = (type: string, payload: Record<string, unknown>): StoredEvent =>
  ({ type, ts: 1, source: 'agent:forge', emitterId: 'forge', payload } as unknown as StoredEvent);

describe('event-adapter: forgeax-core callId correlation', () => {
  test('hook:toolCall + hook:toolResult (callId) produce the SAME toolUseId', () => {
    const st = createAdapterState();
    const callId = 'toolu_01MKsGPYJqMtnS1fXzgSHZ4V';

    // forgeax-core shapes seen on disk:
    //   call:   { name, args, toolCall: { id } }
    //   result: { name, callId, ok, result }
    const callOut = adapt(ev('hook:toolCall', { name: 'ask_user', args: { question: 'q' }, toolCall: { id: callId, name: 'ask_user' } }), st);
    const resOut = adapt(ev('hook:toolResult', { name: 'ask_user', callId, ok: true, result: '用户选择了: 「先聊聊灵感」' }), st);

    const use = callOut.find((e) => e.type === 'tool_use') as { toolUseId?: string } | undefined;
    const res = resOut.find((e) => e.type === 'tool_result') as { toolUseId?: string } | undefined;

    expect(use?.toolUseId).toBe(callId);
    expect(res?.toolUseId).toBe(callId);            // was '' before the fix → node stuck running
    expect(res?.toolUseId).toBe(use?.toolUseId);     // call ↔ result correlate → node completes
  });

  test('id-less result (mcp __fxt__ {name,durationMs}) completes via name fallback', () => {
    const st = createAdapterState();
    const id = 'toolu_vrtx_01Mc8a3FHpKVdmewZ16FtsvB';
    // claude-code MCP: call has the id, but the result drops it (only name+duration).
    const callOut = adapt(ev('hook:toolCall', { name: 'mcp__fxt__list_dir', args: {}, callId: id, toolCall: { id, name: 'mcp__fxt__list_dir' } }), st);
    const resOut = adapt(ev('hook:toolResult', { name: 'mcp__fxt__list_dir', durationMs: 0 }), st);
    const use = callOut.find((e) => e.type === 'tool_use') as { toolUseId?: string } | undefined;
    const res = resOut.find((e) => e.type === 'tool_result') as { toolUseId?: string } | undefined;
    expect(use?.toolUseId).toBe(id);
    expect(res?.toolUseId).toBe(id);   // recovered by name fallback → node completes
  });

  test('concurrent same-name tools: name fallback pops LIFO, no cross-wiring of id-bearing results', () => {
    const st = createAdapterState();
    adapt(ev('hook:toolCall', { name: 'glob', toolCall: { id: 'g1' } }), st);
    adapt(ev('hook:toolCall', { name: 'glob', toolCall: { id: 'g2' } }), st);
    // id-bearing result for g1 should resolve to g1 exactly (not the LIFO top)
    const r1 = adapt(ev('hook:toolResult', { name: 'glob', callId: 'g1' }), st);
    expect((r1.find((e) => e.type === 'tool_result') as { toolUseId?: string }).toolUseId).toBe('g1');
    // an id-less result then falls back to the remaining open one (g2)
    const r2 = adapt(ev('hook:toolResult', { name: 'glob', durationMs: 0 }), st);
    expect((r2.find((e) => e.type === 'tool_result') as { toolUseId?: string }).toolUseId).toBe('g2');
  });

  test('claude-code shape (toolCallId / llmMessage.toolCallId) still correlates', () => {
    const st = createAdapterState();
    const id = 'toolu_cc_123';
    const callOut = adapt(ev('hook:toolCall', { name: 'Bash', toolCall: { id } }), st);
    const resOut = adapt(ev('hook:toolResult', { toolCallId: id, result: 'ok' }), st);
    const use = callOut.find((e) => e.type === 'tool_use') as { toolUseId?: string } | undefined;
    const res = resOut.find((e) => e.type === 'tool_result') as { toolUseId?: string } | undefined;
    expect(res?.toolUseId).toBe(use?.toolUseId);
  });
});
