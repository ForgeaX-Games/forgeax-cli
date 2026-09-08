/**
 * Stream E(管线层)验收:#5/#12 三层管线 + sufficiency 短路。Cases E-I1..I3。
 * loop 集成层(E-I4..I13)待 loop 重构稳定后由集成者补(见 plan §Stream E)。
 * 见 docs/features/compaction-overhaul-verification.md §5。
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  CompactionReductionError,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_ANCHOR_SECTION_CHARS,
  MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS,
  MAX_PROACTIVE_SUMMARY_TREE_CALLS,
  proactiveSummaryInputLimit,
  renderDeterministicTextAnchors,
  runCompaction,
  renderDeterministicSummary,
} from '../src/context/compaction-pipeline';
import {
  makeProviderCompactSummarize,
  MAX_OVERSIZED_SUMMARY_DEPTH,
} from '../src/context/compaction-llm';
import { estimateTokens } from '../src/context/deterministic-compact';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import {
  EMPTY_USAGE,
  PROMPT_TOO_LONG_MESSAGE,
  type LLMProvider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderStreamEvent,
} from '../src/provider/types';
import type { CompactPipelineInput } from '../src/context/compaction-types';

const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
// effective=180_000 → sufficiency 0.15 阈 = 27_000 tok

function input(over: Partial<CompactPipelineInput>): CompactPipelineInput {
  return {
    messages: [],
    scenario: 'full',
    marks,
    summarize: async () => '<summary>llm summary</summary>',
    sufficiencyRatio: 0.15,
    messagesToKeep: 0,
    now: 1,
    ...over,
  };
}

describe('Stream E — pipeline (#5/#12)', () => {
  test.each(['max_tokens', 'end_turn'] as const)('%s with an unclosed summary retries the same history once', async (firstStop) => {
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req) {
        requests.push(req);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: requests.length === 1
            ? '<summary>unfinished'
            : '<summary>CODE-84 remains the same project; archive END-84.</summary>' }] },
          usage: EMPTY_USAGE,
          stopReason: requests.length === 1 ? firstStop : 'end_turn',
        };
      },
    };
    const messages: ProviderMessage[] = [{ role: 'user', content: 'CODE-84 same project END-84' }];
    const before = JSON.stringify(messages);
    const result = await runCompaction(input({
      messages, sufficiencyRatio: 0, summarize: makeProviderCompactSummarize(provider, 'm'),
    }));
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.maxOutputTokens)).toEqual([2048, 4096]);
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    expect(requests[1]!.system).not.toEqual(requests[0]!.system);
    expect(JSON.stringify(requests[1]!.system)).toContain('600 output tokens');
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.replacement.content).toContain('CODE-84 remains the same project');
    expect(result.replacement.content).not.toContain('unfinished');
  });

  test.each(['max_tokens', 'end_turn'] as const)('persistent %s output failure stops after two calls without changing history', async (stopReason) => {
    let calls = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        calls++;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '<summary>unfinished' }] },
          usage: EMPTY_USAGE, stopReason };
      },
    };
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Keep this history intact' }];
    const before = JSON.stringify(messages);
    let failure: unknown;
    try {
      await runCompaction(input({ messages, sufficiencyRatio: 0,
        summarize: makeProviderCompactSummarize(provider, 'm') }));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CompactionReductionError);
    expect((failure as CompactionReductionError).diagnostics).toMatchObject({
      reason: stopReason === 'max_tokens' ? 'max_tokens' : 'malformed_summary', providerCalls: 2, headTruncations: 0, splitCount: 0,
    });
    expect(calls).toBe(2);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test('output recovery respects cancellation and does not retry refusal or empty completion', async () => {
    for (const mode of ['abort', 'refusal', 'empty', 'tool_use', 'missing_stop'] as const) {
      const controller = new AbortController();
      let calls = 0;
      const provider: LLMProvider = {
        api: 'stub',
        async *stream() {
          calls++;
          if (mode === 'abort') controller.abort(new Error('user stopped'));
          yield { type: 'assistant', message: { content: [{ type: 'text', text: mode === 'empty' ? '' : '<summary>unfinished' }] },
            usage: EMPTY_USAGE, stopReason: mode === 'abort' ? 'max_tokens' : mode === 'refusal' ? 'refusal' : mode === 'tool_use' ? 'tool_use' : mode === 'missing_stop' ? null : 'end_turn' };
        },
      };
      await expect(runCompaction(input({
        messages: [{ role: 'user', content: 'history' }], sufficiencyRatio: 0,
        signal: controller.signal, summarize: makeProviderCompactSummarize(provider, 'm'),
      }))).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test.each([['max_tokens', 'end_turn'], ['end_turn', 'max_tokens']] as const)('mixed %s then %s failures share one recovery allowance', async (first, second) => {
    let calls = 0;
    const provider: LLMProvider = {
      api: 'stub', async *stream() {
        calls++;
        yield { type: 'assistant', usage: EMPTY_USAGE, stopReason: calls === 1 ? first : second,
          message: { content: [{ type: 'text', text: '<summary>unfinished' }] } };
      },
    };
    await expect(runCompaction(input({ messages: [{ role: 'user', content: 'keep history' }],
      sufficiencyRatio: 0, summarize: makeProviderCompactSummarize(provider, 'm'),
    }))).rejects.toThrow('Compaction summary rejected');
    expect(calls).toBe(2);
  });

  test.each(['max_tokens', 'end_turn'] as const)('parallel %s split leaves recover within the held semaphore slots', async (firstStop) => {
    const seen = new Set<string>();
    let active = 0;
    let peak = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req) {
        const key = JSON.stringify(req.messages);
        const truncated = !seen.has(key);
        seen.add(key);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: truncated ? '<summary>unfinished' : '<summary>preserved facts</summary>' }] },
          usage: EMPTY_USAGE, stopReason: truncated ? firstStop : 'end_turn' };
      },
    };
    const result = await runCompaction(input({
      messages: [{ role: 'user', content: 'x'.repeat(800_000) }], sufficiencyRatio: 0,
      marks: computeWatermarksFromModel({ contextWindow: 128_000 }),
      summarize: makeProviderCompactSummarize(provider, 'm'),
    }));
    expect(result.usedLLM).toBe(true);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS);
    expect(peak).toBeGreaterThan(1);
  });

  test('proactive summary ceiling preserves ordinary small calls and caps large windows at 200k', () => {
    expect(proactiveSummaryInputLimit(0)).toBe(1);
    expect(proactiveSummaryInputLimit(20_000)).toBe(15_000);
    expect(proactiveSummaryInputLimit(60_000)).toBe(45_000);
    expect(proactiveSummaryInputLimit(180_000)).toBe(135_000);
    expect(proactiveSummaryInputLimit(980_000)).toBe(200_000);
  });

  test('E-I1 L1 短路:小上下文 → usedLLM=false, summarize 未被调用', async () => {
    const summarize = mock(async () => '<summary>should NOT be called</summary>');
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: 'short answer' },
    ];
    const r = await runCompaction(input({ messages: msgs, summarize }));
    expect(r.usedLLM).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(0);
    expect(r.replacement.content).toContain('deterministic compaction');
    expect(r.coveredFrom).toBe(0);
    expect(r.coveredTo).toBe(1);
  });

  test('E-I2 L1 不足 → L2 summarize 调用一次,replacement 为摘要', async () => {
    const summarize = mock(async () => '<summary>the real summary</summary>');
    // 造一个 L1 剥不掉、仍很大的上下文(纯 user 文本,无图无 tool result)
    const huge = 'word '.repeat(40_000); // ~50k tok,> 27k 阈
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    const r = await runCompaction(input({ messages: msgs, summarize }));
    expect(r.usedLLM).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(r.replacement.content).toContain('the real summary');
    expect(r.replacement.content).toContain('This session is being continued');
  });

  test('E-I2a single giant text retains deterministic head and tail anchors outside the LLM summary', async () => {
    const giant = `ISSUE84-ANCHOR-HEAD\n${'x'.repeat(200_000)}\nISSUE84-ANCHOR-TAIL`;
    const r = await runCompaction(
      input({
        messages: [{ role: 'user', content: giant }],
        summarize: async () => '<summary>lossy summary without sentinels</summary>',
      }),
    );
    const replacement = String(r.replacement.content);
    expect(r.usedLLM).toBe(true);
    expect(replacement).toContain('lossy summary without sentinels');
    expect(replacement).toContain('<compacted_text_head>');
    expect(replacement).toContain('ISSUE84-ANCHOR-HEAD');
    expect(replacement).toContain('<compacted_text_tail>');
    expect(replacement).toContain('ISSUE84-ANCHOR-TAIL');
  });

  test('E-I2a2 deterministic anchors keep chronological message order at both edges', () => {
    const anchors = renderDeterministicTextAnchors([
      { role: 'user', content: 'FIRST-USER' },
      { role: 'assistant', content: 'SECOND-ASSISTANT' },
      { role: 'user', content: 'THIRD-USER' },
    ] as ProviderMessage[]);
    expect(anchors.indexOf('FIRST-USER')).toBeLessThan(anchors.indexOf('SECOND-ASSISTANT'));
    expect(anchors.indexOf('SECOND-ASSISTANT')).toBeLessThan(anchors.indexOf('THIRD-USER'));
    expect(anchors.lastIndexOf('FIRST-USER')).toBeLessThan(anchors.lastIndexOf('SECOND-ASSISTANT'));
    expect(anchors.lastIndexOf('SECOND-ASSISTANT')).toBeLessThan(anchors.lastIndexOf('THIRD-USER'));
  });

  test('E-I2a3 deterministic anchor section has a hard bound for arbitrary text size', () => {
    const anchors = renderDeterministicTextAnchors([
      { role: 'user', content: 'h'.repeat(2_000_000) },
    ] as ProviderMessage[]);
    expect(anchors.length).toBeLessThanOrEqual(MAX_COMPACTION_ANCHOR_SECTION_CHARS);
  });

  test('E-I2a4 anchors use stripped L1 text and never persist media/base64/data URLs', async () => {
    const imagePayload = 'BASE64-IMAGE-PAYLOAD-' + 'a'.repeat(100_000);
    const textDataUrl = `data:image/png;base64,${'b'.repeat(20_000)}`;
    const r = await runCompaction(
      input({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `HEAD\n${textDataUrl}\n${'x'.repeat(200_000)}\nTAIL` },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: imagePayload },
              },
            ],
          } as unknown as ProviderMessage,
        ],
        summarize: async () => '<summary>media stripped</summary>',
      }),
    );
    const replacement = String(r.replacement.content);
    expect(r.usedLLM).toBe(true);
    expect(replacement).not.toContain(imagePayload);
    expect(replacement).not.toContain(textDataUrl);
    expect(replacement).not.toContain('data:image/png;base64,');
    expect(replacement).toContain('HEAD');
    expect(replacement).toContain('TAIL');
  });

  test('E-I3 L2 非 PTL 失败 → 上抛(供 E 回滚 + 熔断)', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    await expect(
      runCompaction(
        input({
          messages: msgs,
          summarize: async () => {
            throw new Error('model exploded');
          },
        }),
      ),
    ).rejects.toThrow('model exploded');
  });

  test('E-I2b PTL 重试收敛(前2次 PTL 第3次成功)', async () => {
    // Large enough to require LLM compaction, but below the 200k proactive
    // ceiling so this case continues to isolate provider-signalled PTL retry.
    const huge = 'word '.repeat(10_000);
    const msgs: ProviderMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: huge,
    }));
    let calls = 0;
    const r = await runCompaction(
      input({
        messages: msgs,
        // This case isolates provider-signalled PTL retry. A large active
        // window keeps the proactive preflight out of this focused test.
        marks: computeWatermarksFromModel({ contextWindow: 520_000, maxOutputTokens: 20_000 }),
        summarize: async () => {
          calls++;
          if (calls <= 2) throw new Error(`${PROMPT_TOO_LONG_MESSAGE} overflow`);
          return '<summary>converged</summary>';
        },
      }),
    );
    expect(calls).toBe(3);
    expect(r.replacement.content).toContain('converged');
  });

  test('E-I2c single-message split exhaustion is bounded and diagnostic', async () => {
    let caught: unknown;
    try {
      await runCompaction(
        input({
          messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
          summarize: async () => {
            throw new Error(`${PROMPT_TOO_LONG_MESSAGE} still too large`);
          },
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CompactionReductionError);
    const diagnostics = (caught as CompactionReductionError).diagnostics;
    expect(diagnostics).toMatchObject({
      code: 'COMPACTION_REDUCTION_FAILED',
      version: 1,
      reason: 'split_exhausted',
      inputMessages: 1,
      headTruncations: 0,
      maxSplitDepthReached: MAX_OVERSIZED_SUMMARY_DEPTH,
      maxSplitDepth: MAX_OVERSIZED_SUMMARY_DEPTH,
    });
    expect(diagnostics.splitCount).toBeGreaterThanOrEqual(MAX_OVERSIZED_SUMMARY_DEPTH);
    expect(diagnostics.splitCount).toBeLessThanOrEqual(
      2 ** MAX_OVERSIZED_SUMMARY_DEPTH - 1,
    );
    expect(diagnostics.providerCalls).toBeGreaterThan(0);
    expect(diagnostics.providerCalls).toBeLessThanOrEqual(MAX_COMPACTION_PROVIDER_CALLS);
  });

  test('E-I2d provider stop-reason overflow drives bounded splitting with the active signal', async () => {
    const controller = new AbortController();
    const receivedSignals: AbortSignal[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(
        req: ProviderRequest,
        opts: { signal: AbortSignal },
      ): AsyncIterable<ProviderStreamEvent> {
        calls++;
        receivedSignals.push(opts.signal);
        const inputChars = String(req.messages[0]?.content ?? '').length;
        const overflow = inputChars > 120_000;
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: overflow ? '<summary>partial</summary>' : '<summary>leaf facts</summary>' }],
          },
          usage: EMPTY_USAGE,
          stopReason: overflow ? 'model_context_window_exceeded' : 'end_turn',
        };
      },
    };
    const result = await runCompaction(
      input({
        messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
        summarize: makeProviderCompactSummarize(provider, 'm'),
        signal: controller.signal,
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(receivedSignals.length).toBeGreaterThan(0);
    expect(receivedSignals.every((signal) => signal === receivedSignals[0])).toBe(true);
    expect(receivedSignals[0]).not.toBe(controller.signal);
  });

  test('E-I2d2 proactive preflight bounds mixed text, image, and resource input before the first provider call', async () => {
    const providerTokenCounts: number[] = [];
    const activeLimit = proactiveSummaryInputLimit(marks.effectiveWindow);
    const result = await runCompaction(
      input({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `HEAD-${'x'.repeat(800_000)}` },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(2_000_000) },
              },
              {
                type: 'resource',
                mimeType: 'text/plain',
                data: `${'y'.repeat(800_000)}-TAIL`,
              },
            ],
          } as unknown as ProviderMessage,
        ],
        summarize: async (messages) => {
          providerTokenCounts.push(estimateTokens(messages));
          return '<summary>mixed blocks preserved</summary>';
        },
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(providerTokenCounts.length).toBeGreaterThan(1);
    expect(providerTokenCounts.length).toBeLessThanOrEqual(MAX_COMPACTION_PROVIDER_CALLS);
    expect(Math.max(...providerTokenCounts)).toBeLessThanOrEqual(activeLimit);
  });

  test('E-I2d2b 6.84 MB singleton fits a 128k-window kernel after bounded splitting', async () => {
    const issueScaleChars = 6_840_128;
    const constrainedMarks = computeWatermarksFromModel({ contextWindow: 128_000 });
    const activeLimit = proactiveSummaryInputLimit(constrainedMarks.effectiveWindow);
    const providerTokenCounts: number[] = [];
    const head = 'ISSUE84-PACKAGED-FINAL-HEAD\n';
    const tail = '\nISSUE84-PACKAGED-FINAL-TAIL';
    const giant = head + 'x'.repeat(issueScaleChars - head.length - tail.length) + tail;

    const result = await runCompaction(
      input({
        marks: constrainedMarks,
        messages: [{ role: 'user', content: giant }],
        summarize: async (messages) => {
          providerTokenCounts.push(estimateTokens(messages));
          return '<summary>issue 84 packaged overflow recovered</summary>';
        },
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(providerTokenCounts.length).toBeGreaterThan(2 ** 4);
    expect(providerTokenCounts.length).toBeLessThanOrEqual(MAX_PROACTIVE_SUMMARY_TREE_CALLS);
    expect(Math.max(...providerTokenCounts)).toBeLessThanOrEqual(activeLimit);
    expect(result.replacement.content).toContain('ISSUE84-PACKAGED-FINAL-HEAD');
    expect(result.replacement.content).toContain('ISSUE84-PACKAGED-FINAL-TAIL');
  });

  test('E-I2d3 proactive preflight partitions a long multi-message history chronologically', async () => {
    const providerTokenCounts: number[] = [];
    const activeLimit = proactiveSummaryInputLimit(marks.effectiveWindow);
    const result = await runCompaction(
      input({
        messages: Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `history-${index}-` + 'z'.repeat(80_000),
        })) as ProviderMessage[],
        summarize: async (messages) => {
          providerTokenCounts.push(estimateTokens(messages));
          return '<summary>history partition</summary>';
        },
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(providerTokenCounts.length).toBeGreaterThan(1);
    expect(providerTokenCounts.length).toBeLessThanOrEqual(MAX_COMPACTION_PROVIDER_CALLS);
    expect(Math.max(...providerTokenCounts)).toBeLessThanOrEqual(activeLimit);
  });

  test('E-I2d3b proactive split never sends an orphaned adjacent tool exchange', async () => {
    const pairStates: Array<{ hasUse: boolean; hasResult: boolean }> = [];
    const result = await runCompaction(
      input({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'pair-1',
                name: 'Bash',
                input: { command: 'x'.repeat(520_000) },
              },
            ],
          } as unknown as ProviderMessage,
          {
            role: 'user',
            content: [
              { type: 'text', text: 'result follows' },
              { type: 'tool_result', tool_use_id: 'pair-1', content: 'ok' },
            ],
          } as unknown as ProviderMessage,
          { role: 'user', content: 'tail-' + 'y'.repeat(500_000) },
        ],
        summarize: async (messages) => {
          const serialized = JSON.stringify(messages);
          const hasUse = serialized.includes('"id":"pair-1"');
          const hasResult = serialized.includes('"tool_use_id":"pair-1"');
          pairStates.push({ hasUse, hasResult });
          return '<summary>paired history</summary>';
        },
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(pairStates.length).toBe(3);
    expect(pairStates.every(({ hasUse, hasResult }) => hasUse === hasResult)).toBe(true);
  });

  test('E-I2d3c an oversized two-message tool exchange is text-split without native orphans', async () => {
    const nativePairStates: Array<{ hasUse: boolean; hasResult: boolean }> = [];
    const result = await runCompaction(
      input({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'large-pair',
                name: 'Edit',
                input: { old_string: 'x'.repeat(800_000) },
              },
            ],
          } as unknown as ProviderMessage,
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'large-pair', content: 'done' },
            ],
          } as unknown as ProviderMessage,
        ],
        summarize: async (messages) => {
          const hasNativeUse = messages.some((message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_use'),
          );
          const hasNativeResult = messages.some((message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_result'),
          );
          nativePairStates.push({ hasUse: hasNativeUse, hasResult: hasNativeResult });
          return '<summary>large pair retained</summary>';
        },
      }),
    );

    expect(result.usedLLM).toBe(true);
    expect(nativePairStates.length).toBeGreaterThan(1);
    expect(nativePairStates.every(({ hasUse, hasResult }) => hasUse === hasResult)).toBe(true);
  });

  test('E-I2d4 proactive tree stops before another provider call when the active turn aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    let caught: unknown;
    try {
      await runCompaction(
        input({
          messages: [{ role: 'user', content: 'x'.repeat(1_600_000) }],
          signal: controller.signal,
          summarize: async () => {
            calls++;
            controller.abort();
            return '<summary>first leaf</summary>';
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CompactionReductionError);
    expect((caught as CompactionReductionError).diagnostics.reason).toBe('aborted');
    expect(calls).toBe(1);
  });

  test('E-I2d4b a direct summary cannot resolve successfully after the active turn aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    let caught: unknown;
    try {
      await runCompaction(
        input({
          messages: [{ role: 'user', content: 'x'.repeat(200_000) }],
          signal: controller.signal,
          summarize: async (_messages, _scenario, signal) => {
            calls++;
            controller.abort(new Error('cancel direct summary'));
            expect(signal?.aborted).toBe(true);
            return '<summary>must not be committed</summary>';
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CompactionReductionError);
    expect((caught as CompactionReductionError).diagnostics.reason).toBe('aborted');
    expect(calls).toBe(1);
  });

  test('E-I2d5 proactive branches run with bounded concurrency and retain chronological merge order', async () => {
    let active = 0;
    let maxActive = 0;
    const mergeInputs: string[] = [];
    const startedLeaves: number[] = [];
    const result = await runCompaction(
      input({
        messages: Array.from({ length: 4 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `history-${index}-` + 'x'.repeat(300_000),
        })) as ProviderMessage[],
        summarize: async (messages) => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            const serialized = JSON.stringify(messages);
            if (serialized.includes('chunk summaries')) {
              mergeInputs.push(serialized);
              const ordered = [...serialized.matchAll(/leaf-(\d)/g)].map((match) => match[1]);
              return `<summary>${ordered.map((value) => `leaf-${value}`).join(',')}</summary>`;
            }
            const match = serialized.match(/history-(\d)-/);
            const index = Number(match?.[1] ?? -1);
            startedLeaves.push(index);
            await Bun.sleep((4 - index) * 10);
            return `<summary>leaf-${index}</summary>`;
          } finally {
            active--;
          }
        },
      }),
    );

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS);
    expect(startedLeaves.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(mergeInputs.length).toBe(3);
    expect(result.replacement.content).toContain('leaf-0,leaf-1,leaf-2,leaf-3');
  });

  test('E-I2d6 non-PTL branch failure aborts in-flight siblings and starts no queued work', async () => {
    let calls = 0;
    let siblingAborts = 0;
    let caught: unknown;
    try {
      await runCompaction(
        input({
          messages: [{ role: 'user', content: 'x'.repeat(6_840_000) }],
          summarize: async (_messages, _scenario, signal) => {
            const call = ++calls;
            if (call === 1) {
              await Bun.sleep(10);
              throw new Error('terminal provider failure');
            }
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                siblingAborts++;
                resolve();
                return;
              }
              signal?.addEventListener(
                'abort',
                () => {
                  siblingAborts++;
                  resolve();
                },
                { once: true },
              );
            });
            throw new Error('sibling aborted');
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CompactionReductionError);
    expect((caught as CompactionReductionError).diagnostics.reason).toBe('provider_error');
    expect(calls).toBe(MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS);
    expect(siblingAborts).toBe(MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS - 1);
  });

  test('E-I2e adversarial merge overflow remains bounded by split depth and provider-call budget', async () => {
    let calls = 0;
    let mergeCalls = 0;
    let caught: unknown;
    try {
      await runCompaction(
        input({
          // ~180k estimated tokens: above the 75k L1 sufficiency threshold but
          // below the 200k proactive cap, so this isolates the provider-driven
          // tree and its independent shared call budget.
          messages: [{ role: 'user', content: 'x'.repeat(720_000) }],
          marks: computeWatermarksFromModel({ contextWindow: 520_000, maxOutputTokens: 20_000 }),
          summarize: async (messages) => {
            calls++;
            const serialized = JSON.stringify(messages[0]);
            const isMerge = serialized.includes('chunk summaries');
            if (isMerge) {
              mergeCalls++;
              // Let the ordinary tree consume its normal calls, then keep
              // rejecting merge summaries. The split-depth guard may stop the
              // adversarial provider before the independent call budget; both
              // limits must remain intact and diagnostic.
              if (mergeCalls >= 15) {
                throw new Error(`${PROMPT_TOO_LONG_MESSAGE} merged summary overflow`);
              }
              return '<summary>merged facts</summary>';
            }
            if (serialized.length < 50_000) return '<summary>leaf facts</summary>';
            throw new Error(`${PROMPT_TOO_LONG_MESSAGE} adversarial recursive overflow`);
          },
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CompactionReductionError);
    const diagnostics = (caught as CompactionReductionError).diagnostics;
    expect(['split_exhausted', 'provider_call_budget_exhausted']).toContain(diagnostics.reason);
    expect(diagnostics.providerCalls).toBeLessThanOrEqual(MAX_COMPACTION_PROVIDER_CALLS);
    expect(diagnostics.providerCallBudget).toBe(MAX_COMPACTION_PROVIDER_CALLS);
    expect(calls).toBe(diagnostics.providerCalls);
    expect(mergeCalls).toBeGreaterThanOrEqual(15);
  });

  for (const fixture of [
    { tool: 'Bash', field: 'command' },
    { tool: 'Edit', field: 'old_string' },
  ] as const) {
    test(`E-I2f issue-scale nested ${fixture.tool}.${fixture.field} completes its required four-level tree`, async () => {
      // The live #84 reproduction was 6.84M CJK characters (about 1.8M
      // provider tokens). A 500k serialized-character stub window forces the
      // same four split levels while keeping the test provider deterministic.
      const issueScalePayload =
        'ISSUE84-NESTED-HEAD\n' + '汉'.repeat(6_840_000) + '\nISSUE84-NESTED-TAIL';
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      const result = await runCompaction(
        input({
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  name: fixture.tool,
                  input: {
                    [fixture.field]: issueScalePayload,
                    description: 'issue 84 nested argument regression',
                  },
                },
              ],
            } as unknown as ProviderMessage,
          ],
          summarize: async (messages) => {
            calls++;
            active++;
            maxActive = Math.max(maxActive, active);
            try {
              await Bun.sleep(1);
              if (JSON.stringify(messages).length > 500_000) {
                throw new Error(`${PROMPT_TOO_LONG_MESSAGE} issue-scale nested argument`);
              }
              return '<summary>issue-scale nested argument preserved</summary>';
            } finally {
              active--;
            }
          },
        }),
      );

      expect(result.usedLLM).toBe(true);
      expect(result.replacement.content).toContain('issue-scale nested argument preserved');
      // This fixture's 500k stub limit needs exactly four split levels even
      // though the safety ceiling now permits a fifth for smaller real windows.
      expect(calls).toBe(2 ** (4 + 1) - 1);
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS);
    });
  }

  test('messagesToKeep:保留尾部不进压缩范围', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: 'recent tail' },
    ];
    const r = await runCompaction(input({ messages: msgs, messagesToKeep: 1, summarize: async () => '<summary>s</summary>' }));
    expect(r.coveredTo).toBe(1); // 只覆盖前 2 条,尾 1 条保留
  });

  test('messagesToKeep anchor path keeps an adjacent tool_use/tool_result pair outside the covered range', async () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: `HEAD-${'x'.repeat(200_000)}-TAIL` },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'anchor-pair', name: 'Read', input: { path: 'a.ts' } }],
      } as unknown as ProviderMessage,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'anchor-pair', content: 'pair result' }],
      } as unknown as ProviderMessage,
    ];
    const r = await runCompaction(
      input({
        messages: msgs,
        messagesToKeep: 1,
        summarize: async () => '<summary>prefix only</summary>',
      }),
    );
    const replacement = String(r.replacement.content);
    expect(r.usedLLM).toBe(true);
    expect(r.coveredTo).toBe(0);
    expect(replacement).not.toContain('anchor-pair');
    expect(replacement).not.toContain('pair result');
  });

  test('renderDeterministicSummary:结构化骨架', () => {
    const out = renderDeterministicSummary([
      { role: 'user', content: 'do X' } as ProviderMessage,
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] } as unknown as ProviderMessage,
    ]);
    expect(out).toContain('<previous_user_message>');
    expect(out).toContain('do X');
    expect(out).toContain('tool_call Read');
  });
});
