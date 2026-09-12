import { expect, test } from 'bun:test';
import { TurnUsage } from '../src/kernel-facade/turn-usage';
import { normalizeOpenAIStream } from '../src/provider/openai-compat';
import { normalizeAnthropicStream } from '../src/provider/anthropic';
import { EMPTY_USAGE, type ProviderStreamEvent } from '../src/provider/types';

async function* frames(values: unknown[]) { for (const value of values) yield { data: JSON.stringify(value) }; }
const final = (inputTokens: number, outputTokens: number): ProviderStreamEvent => ({ type: 'assistant',
  message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage: { ...EMPTY_USAGE, inputTokens, outputTokens } });

test('OpenAI tail usage survives final aggregation and multiple provider calls without duplication', async () => {
  const totals = new TurnUsage();
  for (let i = 0; i < 2; i++) {
    totals.begin();
    for await (const event of normalizeOpenAIStream(frames([
      { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } },
    ]))) totals.observe(event);
  }
  expect(totals.values()).toEqual({ inputTokens: 14, outputTokens: 8, cacheRead: 6, cacheCreation: undefined });
  expect(totals.values()).toEqual({ inputTokens: 14, outputTokens: 8, cacheRead: 6, cacheCreation: undefined });
});

test('Anthropic start, output delta and final snapshot count once per invocation', async () => {
  const totals = new TurnUsage();
  totals.begin();
  for await (const event of normalizeAnthropicStream(frames([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]))) totals.observe(event);
  expect(totals.values()).toEqual({ inputTokens: 10, outputTokens: 4, cacheRead: 3, cacheCreation: 2 });
});

test('reported partial usage remains on cancellation before final assistant', async () => {
  const totals = new TurnUsage();
  totals.begin();
  for await (const event of normalizeOpenAIStream(frames([
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ]))) {
    totals.observe(event);
    if (event.type === 'message_delta') break; // consumer cancels at the usage chunk
  }
  expect(totals.values()).toMatchObject({ inputTokens: 10, outputTokens: 4 });
});

test('agent retries and provider-internal retries add separate reported requests', () => {
  const totals = new TurnUsage();
  totals.begin();
  totals.observe({ type: 'message_start', usage: {} });
  totals.observe(final(10, 2));
  totals.observe({ type: 'message_start', usage: {} }); // internal retry boundary
  totals.observe(final(20, 3));
  totals.begin(); // agent recovery retries the same turn index
  totals.observe(final(30, 4));
  expect(totals.values()).toMatchObject({ inputTokens: 60, outputTokens: 9 });
});

test('no reported usage stays unknown, including normal OpenAI completion without usage', async () => {
  const totals = new TurnUsage();
  totals.begin();
  for await (const event of normalizeOpenAIStream(frames([
    { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] },
  ]))) totals.observe(event);
  expect(totals.values().inputTokens).toBeUndefined();
  expect(totals.values().outputTokens).toBeUndefined();
  totals.begin(); totals.observe(final(10, 2));
  expect(totals.values().inputTokens).toBeUndefined(); // known subtotal is not a complete total
});

for (const api of ['openai', 'anthropic'] as const) test(`${api} partial usage keeps missing counters unknown`, async () => {
  const totals = new TurnUsage(); totals.begin();
  const stream = api === 'openai'
    ? normalizeOpenAIStream(frames([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { completion_tokens: 4 } }]))
    : normalizeAnthropicStream(frames([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' }]));
  for await (const event of stream) totals.observe(event);
  expect(totals.values()).toEqual({ inputTokens: undefined, outputTokens: 4, cacheRead: undefined, cacheCreation: undefined });
});

test('reported zero is preserved and incomplete calls cannot become a complete total', async () => {
  const totals = new TurnUsage(); totals.begin();
  for await (const event of normalizeOpenAIStream(frames([
    { choices: [], usage: { completion_tokens: 0 } },
  ]))) totals.observe(event);
  expect(totals.values().outputTokens).toBe(0);
  expect(totals.values().inputTokens).toBeUndefined();
  totals.begin(); totals.observe(final(10, 2));
  expect(totals.values()).toMatchObject({ inputTokens: undefined, outputTokens: 2 });
});

test('Anthropic split snapshots retain only observed counters including explicit zero', async () => {
  const totals = new TurnUsage(); totals.begin();
  for await (const event of normalizeAnthropicStream(frames([
    { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]))) totals.observe(event);
  expect(totals.values()).toEqual({ inputTokens: 12, outputTokens: 4, cacheRead: 0, cacheCreation: undefined });
});
