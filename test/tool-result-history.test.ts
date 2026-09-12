import { describe, expect, test } from 'bun:test';
import { toolResultValue, toolResultsToContent } from '../src/capability/tool-result';
import { llmFoldAdapter } from '../src/history/llm-fold-adapter';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import { buildTool } from '../src/capability/types';
import { EMPTY_USAGE, type LLMProvider, type ProviderRequest } from '../src/provider/types';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime/contract';

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=' } };
const cases = [
  ['read_file', { content: 'file body', numLines: 1 }, 'file body'],
  ['glob', { files: ['src/a.ts'], truncated: false }, 'src/a.ts'],
  ['grep', { matches: [{ path: 'a.ts', line: 2, text: 'needle' }] }, 'needle'],
  ['image', { content: 'image file', imageBlocks: [image] }, image.source.data],
  ['host-text', 'host body', 'host body'],
  ['host-structured', { nested: { result: 'inner' }, result: 'business result' }, 'business result'],
] as const;

describe('tool output across live model, facade and fresh history', () => {
  for (const [name, output, marker] of cases) test(name, async () => {
    const host = name.startsWith('host');
    const seen: ProviderRequest[] = [];
    const provider: LLMProvider = { api: 'stub', async *stream(request) {
      seen.push(structuredClone(request));
      yield { type: 'assistant', usage: EMPTY_USAGE, stopReason: seen.length === 1 ? 'tool_use' : 'end_turn',
        message: { role: 'assistant', content: seen.length === 1
          ? [{ type: 'tool_use', id: 'call', name, input: {} }] : [{ type: 'text', text: 'done' }] } };
    } };
    const local = buildTool({ name, maxResultSizeChars: Infinity, call: async () => ({ data: output }),
      mapResult: data => ({ type: 'tool.result', ts: 3, payload: { toolUseId: 'call', isError: false, ...(data as object) } }) });
    const kernel = new ForgeaxCoreKernel({ provider, localToolImpls: [local], executeTool: async () => output });
    const request: TurnRequest = { session: { threadId: 't', agentId: 'a' }, systemPrompt: { charter: '', persona: '' }, input: { text: 'run' },
      tools: [{ name, delivery: host ? 'host' : 'local', inputSchema: {} }], budget: { maxTurns: 3 } };
    const events: KernelEvent[] = [];
    for await (const e of kernel.runTurn(request, new AbortController().signal)) events.push(e);
    const result = events.find((e): e is Extract<KernelEvent, { kind: 'tool.result' }> => e.kind === 'tool.result')!;
    expect(result.result).toEqual(output);
    expect(JSON.stringify(seen[1].messages)).toContain(marker);
    if (name === 'host-structured') expect(JSON.stringify(seen[1].messages)).toContain('inner');
    // A fresh run receives only the public result, as a host would persist it.
    for await (const _ of kernel.runTurn({ ...request, history: [
      { role: 'assistant', content: '', toolCalls: [{ callId: 'call', name, args: {} }] },
      { role: 'tool', callId: 'call', ok: result.ok, result: result.result },
    ] }, new AbortController().signal)) { /* drain */ }
    expect(JSON.stringify(seen[2].messages)).toContain(marker);
    if (name === 'image') expect(JSON.stringify(seen[2].messages)).toContain('"type":"image"');
  });
});

test('fold preserves native text, structured data, images, errors and correlation', () => {
  for (const [, output, marker] of cases) {
    const payload = { toolUseId: 'call', isError: false, result: output };
    const event = { type: 'tool.result', ts: 99, payload };
    const folded = llmFoldAdapter.toMessage(event);
    const live = toolResultsToContent([{ toolUseId: 'call', toolName: 'tool', isError: false, result: event }]);
    expect(folded.content).toEqual(live);
    const stored = { ...event, payload: { toolUseId: 'call', result: payload, isError: false } };
    expect(llmFoldAdapter.toMessage(stored).content).toEqual(live);
    expect(JSON.stringify(folded)).toContain(marker);
    expect(JSON.stringify(folded)).toContain('call');
  }
  expect(llmFoldAdapter.toMessage({ type: 'tool.result', ts: 1,
    payload: { callId: 'bad', ok: false, message: 'denied' } })).toMatchObject({
      content: [{ tool_use_id: 'bad', is_error: true, content: 'denied' }],
    });
});

test('extracts only payload output, preserves falsy values and does not recursively unwrap business data', () => {
  for (const result of ['', false, 0, null, { result: 'business', privateField: 'returned by tool' }]) {
    expect(toolResultValue({ result, callId: 'a', ok: true, traceId: 'not output' })).toEqual(result);
  }
});
