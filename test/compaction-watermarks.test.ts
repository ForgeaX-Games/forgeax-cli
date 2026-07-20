/**
 * Stream A 验收:水位 & 比例阈值(#1)。Cases A-U1..U8。
 * 见 docs/features/compaction-overhaul-verification.md §1。
 */
import { describe, test, expect } from 'bun:test';
import {
  computeWatermarks,
  computeWatermarksFromModel,
  describeWindowOverride,
  minMeaningfulWindow,
  BASE_PROMPT_TOKENS,
  RESERVED_FOR_SUMMARY_TOKENS,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_BUFFER_TOKENS,
  BLOCKING_BUFFER_TOKENS,
} from '../src/context/watermarks';
import { lookupModelContext, FALLBACK_MODEL_CONTEXT } from '../src/context/model-context-table';

describe('Stream A — watermarks 比例/per-model (#1)', () => {
  test('A-U1 比例计算逐值正确', () => {
    const w = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(w.effectiveWindow).toBe(180_000); // 200k - min(64k,20k)=20k
    expect(w.preCompactThreshold).toBe(144_000); // 180k*0.80
    expect(w.emergencyThreshold).toBe(165_600); // 180k*0.92
    expect(w.warningThreshold).toBe(108_000); // 180k*0.60
    expect(w.blockingLimit).toBe(177_000); // 180k-3k
    expect(w.autoCompactThreshold).toBe(165_600); // = emergency(旧 strategy 复用)
  });

  test('A-U2 预留取小:maxOut<20k 用 maxOut', () => {
    const w = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 8_000 });
    expect(w.effectiveWindow).toBe(192_000); // 200k - 8k
  });

  test('A-U3 per-model lookup 命中', () => {
    expect(lookupModelContext('claude-opus-4-8[1m]').contextWindow).toBe(1_000_000);
    expect(lookupModelContext('gpt-4o-2024-11-20').contextWindow).toBe(128_000);
    expect(lookupModelContext('gemini-2.5-pro').contextWindow).toBe(1_000_000);
    expect(lookupModelContext('deepseek-chat').contextWindow).toBe(128_000);
    // overrides 精确优先
    expect(
      lookupModelContext('my-model', { 'my-model': { contextWindow: 42 } }).contextWindow,
    ).toBe(42);
  });

  test('A-U4 未知 model → fallback(200k);旧绝对函数行为不变', () => {
    expect(lookupModelContext('totally-unknown-xyz')).toEqual(FALLBACK_MODEL_CONTEXT);
    expect(lookupModelContext(undefined)).toEqual(FALLBACK_MODEL_CONTEXT);
    // 旧 computeWatermarks(number) 绝对 buffer 不变(既有测试依赖)
    const legacy = computeWatermarks(200_000);
    expect(legacy.effectiveWindow).toBe(200_000 - RESERVED_FOR_SUMMARY_TOKENS); // 180k
    expect(legacy.autoCompactThreshold).toBe(180_000 - AUTOCOMPACT_BUFFER_TOKENS); // 167k
    expect(legacy.warningThreshold).toBe(180_000 - WARNING_BUFFER_TOKENS); // 160k
    expect(legacy.blockingLimit).toBe(180_000 - BLOCKING_BUFFER_TOKENS); // 177k
  });

  test('A-U5 env pct override(合法生效 / 非法忽略)', () => {
    const ok = computeWatermarksFromModel(
      { contextWindow: 200_000, maxOutputTokens: 64_000 },
      { env: { FORGEAX_COMPACT_PCT_OVERRIDE: '70' } },
    );
    expect(ok.preCompactThreshold).toBe(126_000); // 180k*0.70
    for (const bad of ['0', '150', 'abc', '']) {
      const w = computeWatermarksFromModel(
        { contextWindow: 200_000, maxOutputTokens: 64_000 },
        { env: { FORGEAX_COMPACT_PCT_OVERRIDE: bad } },
      );
      expect(w.preCompactThreshold).toBe(144_000); // 回默认 0.80
    }
  });

  test('A-U6 env window cap', () => {
    const w = computeWatermarksFromModel(
      { contextWindow: 200_000, maxOutputTokens: 64_000 },
      { env: { FORGEAX_COMPACT_WINDOW: '50000' } },
    );
    expect(w.effectiveWindow).toBe(30_000); // min(200k,50k)=50k - 20k
  });

  test('A-U7 单调性 warning<preCompact<emergency<effective, blocking≥0', () => {
    const w = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(w.warningThreshold).toBeLessThan(w.preCompactThreshold);
    expect(w.preCompactThreshold).toBeLessThan(w.emergencyThreshold);
    expect(w.emergencyThreshold).toBeLessThan(w.effectiveWindow);
    expect(w.blockingLimit).toBeGreaterThanOrEqual(0);
  });

  test('A-U8 极小窗口钳制,不出负数', () => {
    const w = computeWatermarksFromModel({ contextWindow: 10_000 }); // reserve 20k > window
    expect(w.effectiveWindow).toBe(0);
    expect(w.preCompactThreshold).toBe(0);
    expect(w.emergencyThreshold).toBe(0);
    expect(w.warningThreshold).toBe(0);
    expect(w.blockingLimit).toBe(0);
  });
});

describe('CORE-CTX-002 — 危险带 FORGEAX_COMPACT_WINDOW 拒绝回落', () => {
  const model = { contextWindow: 200_000, maxOutputTokens: 64_000 }; // reserve=20k → 危险带 (23k, 29k)

  test('minMeaningfulWindow = reserve + basePrompt + blocking(危险带上边界)', () => {
    expect(minMeaningfulWindow(20_000)).toBe(20_000 + BASE_PROMPT_TOKENS + BLOCKING_BUFFER_TOKENS); // 29_000
  });

  test('危险带内(24000:blocking=1000∈(0,6k))→ 忽略,回落模型真实窗口(不再每轮硬停)', () => {
    const w = computeWatermarksFromModel(model, { env: { FORGEAX_COMPACT_WINDOW: '24000' } });
    // 若采纳 24000:effective=4000, blocking=1000(< 基础提示 6k)→ 每轮硬停。忽略后回落 200k:
    expect(w.effectiveWindow).toBe(180_000);
    expect(w.blockingLimit).toBe(177_000);
  });

  test('带下方(22000:blocking=clamp0(-1000)=0)→ 采纳(blocking=0 不硬停,转 PTL 路)', () => {
    const w = computeWatermarksFromModel(model, { env: { FORGEAX_COMPACT_WINDOW: '22000' } });
    expect(w.effectiveWindow).toBe(2_000); // 22k - 20k(采纳,未回落)
    expect(w.blockingLimit).toBe(0);
  });

  test('带上边界(29000:blocking=6000=basePrompt)→ 采纳', () => {
    const w = computeWatermarksFromModel(model, { env: { FORGEAX_COMPACT_WINDOW: '29000' } });
    expect(w.effectiveWindow).toBe(9_000); // 29k - 20k
  });

  test('describeWindowOverride 报告 rejected + floor(供 host warn)', () => {
    const rej = describeWindowOverride(model, { FORGEAX_COMPACT_WINDOW: '24000' });
    expect(rej).toEqual({ requested: 24_000, floor: 29_000, rejected: true });
    const belowBand = describeWindowOverride(model, { FORGEAX_COMPACT_WINDOW: '22000' });
    expect(belowBand.rejected).toBe(false); // blocking=0 不在危险带
    const ok = describeWindowOverride(model, { FORGEAX_COMPACT_WINDOW: '50000' });
    expect(ok.rejected).toBe(false);
    const none = describeWindowOverride(model, {});
    expect(none.rejected).toBe(false);
    expect(none.requested).toBeUndefined();
  });
});

describe('CORE-CTX-003 — 不变量 emergency < blocking(中小窗口)', () => {
  // effectiveWindow = contextWindow - reserve(reserve=min(maxOut??20k,20k)=20k when maxOut undefined)。
  for (const [cw, eff] of [
    [30_000, 10_000],
    [40_000, 20_000],
    [50_000, 30_000],
    [200_000, 180_000],
  ] as const) {
    test(`eff=${eff}: emergency < blocking 且 autoCompact=emergency`, () => {
      const w = computeWatermarksFromModel({ contextWindow: cw }); // maxOut undefined → reserve 20k
      expect(w.effectiveWindow).toBe(eff);
      expect(w.blockingLimit).toBeGreaterThan(0);
      expect(w.emergencyThreshold).toBeLessThan(w.blockingLimit);
      expect(w.autoCompactThreshold).toBe(w.emergencyThreshold);
    });
  }

  test('满窗口 emergency 未被钳(min 不生效,行为不变)', () => {
    const w = computeWatermarksFromModel({ contextWindow: 200_000 });
    expect(w.emergencyThreshold).toBe(165_600); // 180k*0.92 < blocking 177k
  });
});
