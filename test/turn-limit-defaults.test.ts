import { describe, expect, test } from 'bun:test';
import { buildTool } from '../src/capability/types';
import { buildChildSpawnFn } from '../src/cli/peer';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import type { CoreEvent } from '../src/events/types';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime/contract';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const echo = buildTool({
  name: 'echo',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (input: unknown) => ({ data: input }),
  mapResult: (data, id) => ({ type: 'tool.result', payload: { id, data }, ts: 0 }),
  maxResultSizeChars: 1000,
});

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      for (const event of turn) yield event;
    },
  };
}

function longToolLoop(rounds: number, finalText: string): ProviderStreamEvent[][] {
  return [
    ...Array.from({ length: rounds }, (_, i) => [asstToolUse(`t${i}`, 'echo', {})]),
    [asstText(finalText)],
  ];
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    session: { threadId: 'thread', agentId: 'parent' },
    input: { text: 'work' },
    systemPrompt: { charter: 'charter', persona: 'persona' },
    tools: [{ name: 'echo', inputSchema: {} }],
    budget: { maxTurns: 40 },
    ...overrides,
  };
}

async function collectKernel(kernel: ForgeaxCoreKernel, req: TurnRequest): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of kernel.runTurn(req, new AbortController().signal)) events.push(event);
  return events;
}

function assistantText(event: CoreEvent): string {
  const content = (event.payload as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
}

describe('generic child turn defaults', () => {
  test('facade Task child continues beyond 20 turns', async () => {
    const provider = scripted([
      [asstToolUse('parent-task', 'Task', { prompt: 'long child task' })],
      ...longToolLoop(21, 'task child done'),
      [asstText('parent done')],
    ]);
    const kernel = new ForgeaxCoreKernel({
      provider,
      executeTool: async () => null,
    });

    const events = await collectKernel(kernel, request());
    const childDone = events.find(
      (event): event is Extract<KernelEvent, { kind: 'x.subagent.done' }> => event.kind === 'x.subagent.done',
    );
    expect(childDone?.turns).toBe(22);
    expect(childDone?.reason).toBe('completed');
    expect(events.some((event) => event.kind === 'turn.done' && event.reason === 'stop')).toBe(true);
  });

  test('Handoff child spawn default continues beyond 20 turns', async () => {
    const spawn = buildChildSpawnFn(scripted(longToolLoop(21, 'handoff child done')), [echo], 'm');
    const child = await spawn(
      { type: 'helper', requirement: 'long child task' },
      { parentId: 'parent', mode: 'fg' },
    );
    const events: CoreEvent[] = [];
    for await (const event of child.run(new AbortController().signal)) events.push(event);

    const assistant = events.filter((event) => event.type === 'assistant.message');
    expect(assistant).toHaveLength(22);
    expect(assistant.some((event) => assistantText(event) === 'handoff child done')).toBe(true);
  });
});
