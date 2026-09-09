import { expect, test } from 'bun:test';
import { openAIUsageToPartial } from '../src/provider/openai-compat';
import { responsesUsageToPartial } from '../src/provider/openai-response';
import { geminiUsageToPartial } from '../src/provider/gemini';
import { deterministicCompact, OMIT_TOOL_RESULT } from '../src/context/deterministic-compact';
import { runCompaction } from '../src/context/compaction-pipeline';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import { evaluateGate } from '../src/context/compaction-gate';
import { CompactType, DEFAULT_GATE_CONFIG } from '../src/context/compaction-types';
import type { ProviderMessage } from '../src/provider/types';

const marks = computeWatermarksFromModel({ contextWindow: 128000 }, { env: {} });
const mappers = [
  (total: unknown, cache: unknown) => openAIUsageToPartial({ prompt_tokens: total, prompt_cache_hit_tokens: cache }),
  (total: unknown, cache: unknown) => openAIUsageToPartial({ prompt_tokens: total, prompt_tokens_details: { cached_tokens: cache } }),
  (total: unknown, cache: unknown) => responsesUsageToPartial({ input_tokens: total, input_tokens_details: { cached_tokens: cache } }),
  (total: unknown, cache: unknown) => geminiUsageToPartial({ promptTokenCount: total, cachedContentTokenCount: cache }),
];
for (const [i, map] of mappers.entries()) {
  test(`inclusive usage ${i}: cached/uncached/partial/malformed`, () => {
    for (const cached of [0, 45000, 50000, 99000, -1, NaN, Infinity, '45000', undefined]) {
      const u = map(50000, cached);
      expect((u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)).toBe(50000);
      expect(u.inputTokens).toBeGreaterThanOrEqual(0);
    }
    expect(map(50000, 45000)).toEqual({ inputTokens: 5000, cacheReadInputTokens: 45000 });
    expect(map(undefined, 10)).toEqual({});
    expect(map(NaN, -1)).toEqual({});
    expect(map(undefined, undefined)).toEqual({});
  });
}
test('DeepSeek cached fixture stays below the real 86400 precompact gate', () => {
  const usage = openAIUsageToPartial({ prompt_tokens: 50000, prompt_cache_hit_tokens: 45000, completion_tokens: 500 });
  expect(marks.preCompactThreshold).toBe(86400);
  expect(evaluateGate({ tokenCount: usage.inputTokens! + usage.cacheReadInputTokens!, marks,
    type: CompactType.PRE_MESSAGE_AUTO, state: { isCompressing: false, consecutiveFailures: 0 },
    now: 100000, autoCompactEnabled: true, config: DEFAULT_GATE_CONFIG })).toEqual({ compact: false, reason: 'below-threshold' });
});
const facts: ProviderMessage[] = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'bad', name: 'read_file', input: { path: 'src/nonexistent.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'ENOENT src/nonexistent.ts: does not exist; use src/api.ts instead' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'api', name: 'read_file', input: { path: 'src/api.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'api', content: 'export interface InputSnapshot { isKeyPressed(key: string): boolean }' }] },
];
const compact = (messages: ProviderMessage[], ratio = 1, summarize = async (_: readonly ProviderMessage[]) => 'summary') => runCompaction({ messages, marks, sufficiencyRatio: ratio, summarize, messagesToKeep: 0, scenario: 'full', now: 1 });
test('negative outcomes, API signatures, and pairing survive L1 and repeated deterministic compaction', async () => {
  const l1 = deterministicCompact(facts, { toolResultBudgetChars: 24000 });
  expect((l1.messages[1].content as any)[0]).toMatchObject({ tool_use_id: 'bad', is_error: true });
  let messages = facts;
  let firstSize = 0;
  for (let i = 0; i < 10; i++) {
    const r = await compact(messages);
    const text = String(r.replacement.content);
    expect(text).toContain('is_error=true');
    expect(text).toContain('ENOENT src/nonexistent.ts');
    expect(text).toContain('isKeyPressed(key: string)');
    if (i === 0) firstSize = text.length;
    else expect(text.length).toBe(firstSize);
    messages = [r.replacement];
  }
});
test('LLM summary receives observed negative and positive evidence', async () => {
  let called = false;
  const r = await compact(facts, 0, async (messages) => {
    called = true;
    expect(JSON.stringify(messages)).toContain('ENOENT src/nonexistent.ts');
    expect(JSON.stringify(messages)).toContain('isKeyPressed(key: string)');
    return 'ENOENT src/nonexistent.ts; src/api.ts declares isKeyPressed(key: string)';
  });
  expect(called).toBe(true);
  expect(r.usedLLM).toBe(true);
});
test('total evidence budget is bounded; failures have priority over large successful reads', () => {
  const messages = [...facts, ...Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(i), content: 'head API\n' + 'x'.repeat(100000) + '\ntail API' }] }))] as ProviderMessage[];
  const r = deterministicCompact(messages, { toolResultBudgetChars: 24000 });
  const results = r.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : []) as any[];
  expect(results.reduce((sum, b) => sum + (b.content === OMIT_TOOL_RESULT ? 0 : b.content.length), 0)).toBeLessThanOrEqual(24000);
  expect(results[0].content).toContain('ENOENT');
  expect(results.at(-1).content).toContain('tail API');
  expect(results.every((b) => b.content.length <= 1600)).toBe(true);
});

test('multimodal results preserve text but never embed binary data in the summary', async () => {
  const r = await compact([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image', content: [
    { type: 'text', text: 'src/图片.ts: unsupported API createSprite' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SECRET_BINARY'.repeat(10000) } },
  ] }] }] as ProviderMessage[]);
  expect(r.replacement.content).toContain('unsupported API createSprite');
  expect(r.replacement.content).not.toContain('SECRET_BINARY');
});
