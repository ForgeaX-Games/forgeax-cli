/**
 * Context-window watermarks (C7) — token thresholds that drive auto-compact,
 * UI warnings and the hard blocking limit.
 *
 * 两套并存(向后兼容):
 *  - **绝对 buffer**(`computeWatermarks(windowSize)`,既有测试依赖,**行为不变**):
 *      effectiveWindow = window - 20k;autoCompact = effective - 13k;
 *      warning = effective - 20k;blocking = effective - 3k。
 *  - **比例 + per-model**(`computeWatermarksFromModel(modelInfo, config?)`,改造后主用 #1):
 *      reserveForSummary = min(maxOutputTokens, 20k);effective = window - reserve;
 *      preCompact = effective × pct.preCompact(默认 0.80);
 *      emergency  = effective × pct.emergency (默认 0.92);
 *      warning    = effective × pct.warning  (默认 0.60);
 *      blocking   = effective - 3k(硬兜底)。
 *    env override:`FORGEAX_COMPACT_PCT_OVERRIDE`(覆写 preCompact 百分比,取值 1-100)/
 *      `FORGEAX_COMPACT_WINDOW`(把 window 钳到该上限)。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import type { Watermarks } from './types';
import type { ModelContextInfo, WatermarkConfig } from './compaction-types';

/** Tokens reserved for the compaction summary output. */
export const RESERVED_FOR_SUMMARY_TOKENS = 20_000;
/** auto-compact fires this far below the effective window. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** UI warning starts this far below the effective window. */
export const WARNING_BUFFER_TOKENS = 20_000;
/** hard blocking limit sits this far below the effective window. */
export const BLOCKING_BUFFER_TOKENS = 3_000;

/** 默认比例(决策 #1)。 */
export const DEFAULT_PRECOMPACT_PCT = 0.8;
export const DEFAULT_EMERGENCY_PCT = 0.92;
export const DEFAULT_WARNING_PCT = 0.6;

/** 基础系统提示的经验占用(~5.8k token 上取整);低于此的 effective 窗口连基础提示都装不下。 */
export const BASE_PROMPT_TOKENS = 6_000;

/**
 * CORE-CTX-002 的「危险带」判定:给定窗口 + 摘要预留 reserve,`blockingLimit = window − reserve − 3k`
 * 若落在 **(0, basePrompt)** —— 即「blocking 为正、却低于光基础提示就已占用的量」——
 * agent 从第 1 轮起每轮静默硬停 `blocking_limit`(无摘要、无告警)。
 *
 * 注意边界(与 ticket 一致):
 *   - blocking ≤ 0(window ≤ reserve+3k):守卫 `blockingLimit>0` 为假 → **不**硬停,转 PTL 反应式路,安全。
 *   - blocking ≥ basePrompt(window ≥ reserve+3k+basePrompt):窗口够大,水位有意义,安全。
 * 只有中间这条带才是 bug,拒绝该窗口 override、回落真实窗口。
 */
export function isWindowInDangerBand(windowSize: number, reserve: number): boolean {
  const blocking = windowSize - reserve - BLOCKING_BUFFER_TOKENS;
  return blocking > 0 && blocking < BASE_PROMPT_TOKENS;
}

/** 危险带上边界:window ≥ 此值时 blocking ≥ basePrompt,水位有意义(供诊断展示)。 */
export function minMeaningfulWindow(reserve: number): number {
  return reserve + BASE_PROMPT_TOKENS + BLOCKING_BUFFER_TOKENS;
}

/** 非负钳制(极小窗口下不出负阈值,见 A-U8)。 */
function clamp0(n: number): number {
  return n > 0 ? n : 0;
}

/**
 * 旧版:按绝对 buffer 计算水位(`computeWatermarks(windowSize)`)。**行为不变**(既有测试依赖)。
 * 比例字段 `preCompactThreshold`/`emergencyThreshold` 取 `autoCompactThreshold`(旧只有一个自动压点)。
 *
 * @param windowSize 模型上下文窗口 token 数。
 * @param _model     预留 per-model hook(此函数不用;比例版见 computeWatermarksFromModel)。
 */
export function computeWatermarks(windowSize: number, _model?: string): Watermarks {
  const effectiveWindow = windowSize - RESERVED_FOR_SUMMARY_TOKENS;
  const autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  return {
    effectiveWindow,
    preCompactThreshold: autoCompactThreshold,
    emergencyThreshold: autoCompactThreshold,
    autoCompactThreshold,
    warningThreshold: effectiveWindow - WARNING_BUFFER_TOKENS,
    blockingLimit: effectiveWindow - BLOCKING_BUFFER_TOKENS,
  };
}

/** 读 env 比例 override(`FORGEAX_COMPACT_PCT_OVERRIDE`,取值 1-100 → 0.01-1.0);非法/缺省 → undefined。 */
export function readPctOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.FORGEAX_COMPACT_PCT_OVERRIDE;
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return undefined;
  return parsed / 100;
}

/** 读 env 窗口上限(`FORGEAX_COMPACT_WINDOW`);非法/缺省 → undefined。 */
export function readWindowOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.FORGEAX_COMPACT_WINDOW;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * 诊断 `FORGEAX_COMPACT_WINDOW` 是否会被采纳(CORE-CTX-002)。host 在装配期调一次:
 * `rejected` 为真时应 warn 用户「窗口配得太小、已忽略回落真实窗口」,避免 agent 静默每轮硬停。
 * 纯函数(computeWatermarksFromModel 的采纳判定同源),不发副作用。
 *
 * @param modelInfo 模型上下文信息(取 maxOutputTokens 定 reserve)。
 * @param env       env source(默认 process.env)。
 */
export function describeWindowOverride(
  modelInfo: ModelContextInfo,
  env: Record<string, string | undefined> = process.env,
): { requested?: number; floor: number; rejected: boolean } {
  const reserve = Math.min(modelInfo.maxOutputTokens ?? RESERVED_FOR_SUMMARY_TOKENS, RESERVED_FOR_SUMMARY_TOKENS);
  const floor = minMeaningfulWindow(reserve);
  const requested = readWindowOverride(env);
  const clamped = requested !== undefined ? Math.min(modelInfo.contextWindow, requested) : undefined;
  return {
    requested,
    floor,
    rejected: clamped !== undefined && isWindowInDangerBand(clamped, reserve),
  };
}

/**
 * 新版:按**比例 + per-model** 计算水位(改造后主用,决策 #1)。
 *
 * @param modelInfo 模型上下文信息(contextWindow + 可选 maxOutputTokens)。
 * @param config    比例覆写 + env source(测试可注入)。
 */
export function computeWatermarksFromModel(
  modelInfo: ModelContextInfo,
  config?: WatermarkConfig,
): Watermarks {
  const env = config?.env ?? process.env;
  const rawWindow = modelInfo.contextWindow;

  const reserve = Math.min(
    modelInfo.maxOutputTokens ?? RESERVED_FOR_SUMMARY_TOKENS,
    RESERVED_FOR_SUMMARY_TOKENS,
  );

  // CORE-CTX-002:`FORGEAX_COMPACT_WINDOW` 钳窗落进「危险带」(blocking 为正但低于基础提示占用)
  //   时,agent 每轮静默硬停 `blocking_limit`。此时**拒绝该 override**、回落模型真实窗口(不钳窗),
  //   让误配安全降级而非罢工。band 外(blocking≤0 走 PTL / blocking≥basePrompt 有意义)照常采纳。
  //   诊断由 host 在装配期经 describeWindowOverride 发一次 warn(避免此纯函数每轮刷屏)。
  const windowCap = readWindowOverride(env);
  const clampedWindow = windowCap !== undefined ? Math.min(rawWindow, windowCap) : rawWindow;
  const acceptedCap =
    windowCap !== undefined && isWindowInDangerBand(clampedWindow, reserve) ? undefined : windowCap;
  const window = acceptedCap !== undefined ? Math.min(rawWindow, acceptedCap) : rawWindow;

  const effectiveWindow = clamp0(window - reserve);

  const pctOverride = readPctOverride(env);
  const preCompactPct = pctOverride ?? config?.preCompactPct ?? DEFAULT_PRECOMPACT_PCT;
  const emergencyPct = config?.emergencyPct ?? DEFAULT_EMERGENCY_PCT;
  const warningPct = config?.warningPct ?? DEFAULT_WARNING_PCT;

  // Math.round(而非 floor):避开浮点尾差(如 180000×0.7=125999.999→126000),阈值取整更直觉。
  const preCompactThreshold = clamp0(Math.round(effectiveWindow * preCompactPct));
  const warningThreshold = clamp0(Math.round(effectiveWindow * warningPct));
  const blockingLimit = clamp0(effectiveWindow - BLOCKING_BUFFER_TOKENS);
  // CORE-CTX-003:保证不变量 emergency < blocking。中小窗口(eff < ~37.5k)下
  //   0.92·eff 会高于 eff−3k,导致上下文增长「先撞硬停、紧急压缩没机会跑」。把 emergency
  //   钳到 blocking−1 以下(blocking 为 0 的退化窗不钳——交 provider 侧 PTL 反应式兜底)。
  const rawEmergency = Math.round(effectiveWindow * emergencyPct);
  const emergencyThreshold = clamp0(
    blockingLimit > 0 ? Math.min(rawEmergency, blockingLimit - 1) : rawEmergency,
  );

  return {
    effectiveWindow,
    preCompactThreshold,
    emergencyThreshold,
    autoCompactThreshold: emergencyThreshold, // 旧 strategy 复用 = 紧急点
    warningThreshold,
    blockingLimit,
  };
}
