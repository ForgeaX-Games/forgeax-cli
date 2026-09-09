import { expect, test } from 'bun:test';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import { EMPTY_USAGE } from '../src/provider/types';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime/contract';

test('facade emits public start while the summary provider is still pending', async () => {
  let release!: () => void;
  let summaryFinished = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const kernel = new ForgeaxCoreKernel({
    provider: { api: 'stub', async *stream() {
      if (calls++ === 0) { await pending; summaryFinished = true; }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: EMPTY_USAGE, stopReason: 'end_turn' };
    } },
    executeTool: async () => null,
  });
  const request: TurnRequest = {
    session: { threadId: 'compaction-live', agentId: 'forge' }, callId: 'turn-compaction',
    input: { text: 'continue' }, systemPrompt: { charter: '', persona: '' }, tools: [], budget: { maxTurns: 2 },
    history: [{ role: 'user', content: 'context '.repeat(120_000) }],
  };
  const events: KernelEvent[] = [];
  const iterator = kernel.runTurn(request, new AbortController().signal)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      events.push(next.value!);
      if (next.value?.kind === 'stored-event') break;
    }
    expect(summaryFinished).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'stored-event', payload: { type: 'compaction.status', payload: { id: 'turn-compaction', phase: 'started', count: 1 } } });
  } finally { release(); }
  for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
  expect(events.some(e => e.kind === 'stored-event' && (e.payload.payload as Record<string, unknown>).phase === 'completed')).toBe(true);
  expect(events.at(-1)).toMatchObject({ kind: 'turn.done' });
});
