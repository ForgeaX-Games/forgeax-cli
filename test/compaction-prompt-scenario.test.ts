/**
 * Stream D 验收:摘要 prompt scenario + 质量(#2/#3)。Cases D-U1..U9。
 * 见 docs/features/compaction-overhaul-verification.md §4。
 */
import { describe, test, expect } from 'bun:test';
import {
  getCompactPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
  truncateHeadForPTLRetry,
  splitOversizedMessageForSummary,
  makeProviderSummarize,
  ProviderSummaryError,
  LLMCompactionStrategy,
  MAX_PTL_RETRIES,
  COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
} from '../src/context/compaction-llm';
import { EMPTY_USAGE, PROMPT_TOO_LONG_MESSAGE, type LLMProvider, type ProviderRequest } from '../src/provider/types';
import { isPromptTooLong } from '../src/context/reactive-recovery';

const NINE_SECTIONS = [
  '1. Primary Request and Intent',
  '2. Key Technical Concepts',
  '3. Files and Code Sections',
  '4. Errors and fixes',
  '5. Problem Solving',
  '6. All user messages',
  '7. Pending Tasks',
  '8. Current Work',
  '9. Optional Next Step',
];

describe('Stream D — prompt scenario + summary quality (#2/#3)', () => {
  test.each(['<summary>unfinished', 'missing opening tag</summary>'])('legacy strategy recovers malformed output: %s', async (broken) => {
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      api: 'stub', async *stream(req) {
        requests.push(req);
        yield { type: 'assistant', usage: EMPTY_USAGE, stopReason: 'end_turn',
          message: { content: [{ type: 'text', text: requests.length === 1 ? broken : '<summary>snake work can continue</summary>' }] } };
      },
    };
    const strategy = new LLMCompactionStrategy({ summarize: makeProviderSummarize(provider, 'm') });
    const messages = [{ role: 'user', content: 'Continue the existing snake project.' }];
    const original = JSON.stringify(messages);
    const result = await strategy.compact(messages);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    expect(requests.map(r => r.maxOutputTokens)).toEqual([2048, 4096]);
    expect(JSON.stringify(result.replacement)).toContain('snake work can continue');
    expect(JSON.stringify(result.replacement)).not.toContain(broken);
    expect(JSON.stringify(messages)).toBe(original);
  });

  test('D-U1 full:9 段 + no-tools guards', () => {
    const p = getCompactPrompt('full');
    for (const h of NINE_SECTIONS) expect(p).toContain(h);
    expect(p).toContain('Respond with TEXT ONLY');
    expect(p).toContain('REMINDER');
    expect(p).toContain('Return exactly one <summary>...</summary> block');
    expect(p).toContain('under 1,500 output tokens');
    expect(p).not.toContain('<analysis>');
    expect(p).not.toContain('Your thought process');
    expect(p).not.toContain('silently review');
    expect(p).not.toContain('chain of thought');
    expect(p).not.toContain('chain-of-thought');
    expect(p).not.toContain('analyze each message');
    expect(p).not.toContain('<example>');
    expect(p).not.toMatch(/analysis|reasoning|thought process|silently/i);
    expect(p.match(/<summary>/g)).toHaveLength(1);
    expect(p.match(/<\/summary>/g)).toHaveLength(1);
  });

  // (D-U2 partial 场景已随 D-01 删除:该 scenario 从无调用方,按闭合 union 移除。)

  test('D-U3 pre-message:预压场景模板', () => {
    const p = getCompactPrompt('pre-message');
    expect(p).toContain('NEW user message will follow');
    expect(p).not.toBe(getCompactPrompt('full'));
  });

  test('D-U4 customInstructions 追加;空白忽略', () => {
    expect(getCompactPrompt('full', 'focus on X')).toContain('Additional Instructions:\nfocus on X');
    expect(getCompactPrompt('full', '   ')).not.toContain('Additional Instructions:');
  });

  test('D-U5 摘要格式化 + 续接消息', () => {
    expect(formatCompactSummary('<summary>canonical result</summary>')).toBe('Summary:\ncanonical result');
    const raw = '<analysis>scratch</analysis><summary>did the thing</summary>';
    expect(formatCompactSummary(raw)).toBe('Summary:\ndid the thing');
    const msg = getCompactUserSummaryMessage(raw);
    expect(msg).toContain('This session is being continued');
    expect(msg).toContain('did the thing');
    expect(msg).not.toContain('scratch'); // analysis 被剥
  });

  test('D-U6 摘要失败(非 PTL)→ compact 抛错(catchable,供 E 回滚)', async () => {
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        throw new Error('model exploded');
      },
    });
    await expect(s.compact([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).rejects.toThrow(
      'model exploded',
    );
  });

  test('D-U7 PTL 重试收敛(前2次 PTL,第3次成功)', async () => {
    let calls = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        calls++;
        if (calls <= 2) throw new Error(`${PROMPT_TOO_LONG_MESSAGE} overflow`);
        return '<summary>ok</summary>';
      },
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const r = await s.compact(msgs);
    expect(calls).toBe(3);
    expect((r.replacement as any).content).toContain('ok');
  });

  test('D-U8 PTL 耗尽 → 放弃抛错(不死循环)', async () => {
    let calls = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        calls++;
        throw new Error(`${PROMPT_TOO_LONG_MESSAGE} still too big`);
      },
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await expect(s.compact(msgs)).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(MAX_PTL_RETRIES + 1); // 不无限重试
  });

  test('D-U9 self-limit:makeProviderSummarize 用 scenario prompt + 无工具', async () => {
    const captured: any[] = [];
    const fakeProvider: any = {
      async *stream(req: any) {
        captured.push(req);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<summary>x</summary>' }] },
          usage: EMPTY_USAGE,
          stopReason: 'end_turn',
        };
      },
    };
    const sum = makeProviderSummarize(fakeProvider, 'claude-x', 'pre-message');
    await sum([{ role: 'user', content: 'hi' }] as any);
    expect(captured[0].tools).toEqual([]); // 无工具 → 不递归
    expect(captured[0].maxOutputTokens).toBe(COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS);
    expect(captured[0].system[0].text).toContain('NEW user message will follow'); // pre-message 模板
  });

  test('D-U10 split keeps head/middle/tail facts exactly once while repeating envelope metadata', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'HEAD-FACT-ISSUE84' },
        {
          type: 'file',
          name: 'issue84-resource.txt',
          mimeType: 'text/plain',
          data: `MIDDLE-HEAD-ISSUE84-${'y'.repeat(30_000)}-MIDDLE-TAIL-ISSUE84`,
        },
        { type: 'text', text: 'TAIL-FACT-ISSUE84' },
      ],
    };

    const split = splitOversizedMessageForSummary(message as any);
    expect(split).not.toBeNull();
    const [first, second] = split!;
    const firstJson = JSON.stringify(first);
    const secondJson = JSON.stringify(second);
    const joined = firstJson + secondJson;
    const occurrences = (text: string, fact: string) => text.split(fact).length - 1;
    for (const fact of [
      'HEAD-FACT-ISSUE84',
      'MIDDLE-HEAD-ISSUE84',
      'MIDDLE-TAIL-ISSUE84',
      'TAIL-FACT-ISSUE84',
    ]) {
      expect(occurrences(joined, fact)).toBe(1);
    }
    expect(firstJson).toContain('HEAD-FACT-ISSUE84');
    expect(firstJson).not.toContain('TAIL-FACT-ISSUE84');
    expect(secondJson).not.toContain('HEAD-FACT-ISSUE84');
    expect(secondJson).toContain('TAIL-FACT-ISSUE84');
    expect(firstJson).toContain('issue84-resource.txt');
    expect(secondJson).toContain('issue84-resource.txt');
    expect(occurrences(joined, 'issue84-resource.txt')).toBe(2);
    expect(occurrences(joined, 'text/plain')).toBe(2);
    expect(firstJson.length).toBeLessThan(JSON.stringify(message).length);
    expect(secondJson.length).toBeLessThan(JSON.stringify(message).length);
  });

  test('D-U11 model_context_window_exceeded stop reason becomes retryable PTL', async () => {
    const provider: any = {
      api: 'stub',
      async *stream() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<summary>partial</summary>' }] },
          usage: EMPTY_USAGE,
          stopReason: 'model_context_window_exceeded',
        };
      },
    };
    const summarize = makeProviderSummarize(provider, 'm');
    let caught: unknown;
    try {
      await summarize([{ role: 'user', content: 'large' }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderSummaryError);
    expect((caught as ProviderSummaryError).summaryFailureReason).toBe('context_window_exceeded');
    expect(isPromptTooLong(caught)).toBe(true);
  });

  test('D-U10b Bash history splits arbitrary command content and preserves facts once', () => {
    const message = {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'bash-84',
        name: 'Bash',
        input: {
          command: `BASH-HEAD-84-${'x'.repeat(30_000)}-BASH-TAIL-84`,
          description: 'BASH-DESCRIPTION-84',
        },
      }],
    };
    const split = splitOversizedMessageForSummary(message as any);
    expect(split).not.toBeNull();
    const joined = split!.map((part) => JSON.stringify(part)).join('');
    for (const fact of ['BASH-HEAD-84', 'BASH-TAIL-84', 'BASH-DESCRIPTION-84']) {
      expect(joined.split(fact)).toHaveLength(2);
    }
    expect(JSON.stringify(split![0])).toContain('BASH-HEAD-84');
    expect(JSON.stringify(split![1])).toContain('BASH-TAIL-84');
  });

  test('D-U10c Edit history splits old_string without duplicating sibling facts', () => {
    const message = {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'edit-84',
        name: 'Edit',
        input: {
          file_path: '/tmp/issue-84.ts',
          old_string: `EDIT-OLD-HEAD-84-${'y'.repeat(30_000)}-EDIT-OLD-TAIL-84`,
          replacement_value: 'EDIT-REPLACEMENT-84',
        },
      }],
    };
    const split = splitOversizedMessageForSummary(message as any);
    expect(split).not.toBeNull();
    const joined = split!.map((part) => JSON.stringify(part)).join('');
    for (const fact of [
      '/tmp/issue-84.ts',
      'EDIT-OLD-HEAD-84',
      'EDIT-OLD-TAIL-84',
      'EDIT-REPLACEMENT-84',
    ]) {
      expect(joined.split(fact)).toHaveLength(2);
    }
    expect(JSON.stringify(split![0])).toContain('EDIT-OLD-HEAD-84');
    expect(JSON.stringify(split![1])).toContain('EDIT-OLD-TAIL-84');
  });

  test('D-U12 max_tokens and incomplete or empty provider summaries are rejected', async () => {
    const rejectedReason = async (stopReason: any, text?: string, emitAssistant = true) => {
      const provider: any = {
        api: 'stub',
        async *stream() {
          if (emitAssistant) {
            yield {
              type: 'assistant',
              message: { content: text === undefined ? [] : [{ type: 'text', text }] },
              usage: EMPTY_USAGE,
              stopReason,
            };
          } else {
            yield { type: 'message_stop' };
          }
        },
      };
      try {
        await makeProviderSummarize(provider, 'm')([{ role: 'user', content: 'history' }]);
      } catch (error) {
        return (error as ProviderSummaryError).summaryFailureReason;
      }
      return 'accepted';
    };

    expect(await rejectedReason('max_tokens', '<summary>complete despite token cap</summary>')).toBe('accepted');
    expect(await rejectedReason('max_tokens', '<summary>incomplete')).toBe('max_tokens');
    expect(await rejectedReason('max_tokens', '<summary>   </summary>')).toBe('max_tokens');
    expect(await rejectedReason(null, '<summary>partial</summary>')).toBe('incomplete');
    expect(await rejectedReason('refusal', '<summary>not a successful result</summary>')).toBe('incomplete');
    expect(await rejectedReason('tool_use', '<summary>not a successful result</summary>')).toBe('incomplete');
    expect(await rejectedReason('end_turn', '<summary>   </summary>')).toBe('empty');
    expect(await rejectedReason('end_turn', '<summary>unfinished')).toBe('malformed_summary');
    expect(await rejectedReason('end_turn', '', true)).toBe('empty');
    expect(await rejectedReason(null, undefined, false)).toBe('incomplete');
  });

  test('D-U13 legacy compaction forwards the caller AbortSignal to its provider summary', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider: any = {
      api: 'stub',
      async *stream(_req: unknown, opts: { signal: AbortSignal }) {
        received = opts.signal;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<summary>ok</summary>' }] },
          usage: EMPTY_USAGE,
          stopReason: 'end_turn',
        };
      },
    };
    const strategy = new LLMCompactionStrategy({ summarize: makeProviderSummarize(provider, 'm') });
    await strategy.compact(
      [{ role: 'user', content: 'history' }, { role: 'assistant', content: 'answer' }],
      controller.signal,
    );
    expect(received).toBe(controller.signal);
  });

  test.each(['max_tokens', 'end_turn'] as const)('%s persists only the complete summary, not surrounding text', async (stopReason) => {
    const provider: any = {
      api: 'stub',
      async *stream() {
        yield {
          type: 'assistant',
          message: {
            content: [{
              type: 'text',
              text: '<analysis>discard me</analysis><summary>  durable facts  </summary>TRUNCATED-TAIL',
            }],
          },
          usage: EMPTY_USAGE,
          stopReason,
        };
      },
    };

    const summary = await makeProviderSummarize(provider, 'm')([{ role: 'user', content: 'history' }]);

    expect(summary).toBe('<summary>durable facts</summary>');
    expect(summary).not.toContain('discard me');
    expect(summary).not.toContain('TRUNCATED-TAIL');

    const strategy = new LLMCompactionStrategy({ summarize: makeProviderSummarize(provider, 'm') });
    const result = await strategy.compact([{ role: 'user', content: 'history' }]);
    const replacement = (result.replacement as { content: string }).content;
    expect(replacement).toContain('durable facts');
    expect(replacement).not.toContain('TRUNCATED-TAIL');
    expect(replacement).not.toContain('discard me');
  });
});
