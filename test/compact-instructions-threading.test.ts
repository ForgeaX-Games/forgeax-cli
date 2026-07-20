/**
 * 15.13 回归:/compact <侧重指令> 的 instructions 必须透传进压缩 prompt,
 * 不再被 driver 静默丢弃(旧 useAgent.triggerCompact 里的 `void instructions`)。
 *
 * 单测锁 provider 侧接线:makeProviderCompactSummarize(provider, model, instructions)
 * → 请求 system prompt 含 "Additional Instructions:\n<instructions>";无 instructions 时不含。
 */
import { test, expect, describe } from 'bun:test';
import { makeProviderCompactSummarize } from '../src/context/compaction-llm';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function capturingProvider(): { provider: LLMProvider; lastSystem: () => string } {
  let systemText = '';
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      systemText = (req.system ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '<summary>ok</summary>' }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, lastSystem: () => systemText };
}

describe('15.13 compact instructions threading', () => {
  const msgs = [{ role: 'user' as const, content: 'hello' }];

  test('给了 instructions → 追加进压缩 prompt', async () => {
    const { provider, lastSystem } = capturingProvider();
    const summarize = makeProviderCompactSummarize(provider, 'test-model', 'FOCUS ON AUTH FLOW');
    await summarize(msgs, 'full');
    expect(lastSystem()).toContain('Additional Instructions:\nFOCUS ON AUTH FLOW');
  });

  test('未给 instructions → prompt 不含追加段', async () => {
    const { provider, lastSystem } = capturingProvider();
    const summarize = makeProviderCompactSummarize(provider, 'test-model');
    await summarize(msgs, 'full');
    expect(lastSystem()).not.toContain('Additional Instructions:');
  });
});
