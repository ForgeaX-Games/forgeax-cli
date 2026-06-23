/**
 * cacheHitRatio —— prompt-cache 命中率的统一口径。
 *
 * 还原老 forgeax-studio `packages/cli/src/session/xml.ts` 的 `cachedRatio` 打点:
 * 迁到 forgeax-core 内核路径后,原始 cache token 仍端到端贯通(core provider →
 * turn.usage → done.usage → observatory),但「命中率」这个派生指标 + 其可见化在
 * 迁移中遗失,这里补回。
 *
 * Anthropic 口径:`cache_read / (input + cache_create + cache_read)`。
 *   - input(裸输入)= 未命中缓存、本轮新计费的输入 token
 *   - cache_create = 写进缓存的 token(首次/前缀变更时产生)
 *   - cache_read   = 命中缓存读出的 token
 * 三者之和 = 本轮总输入 token,read 占比即命中率。total=0(无输入,如纯工具回合)
 * 返回 undefined,表示「无可报」而非 0%,避免污染统计。
 */
export function cacheHitRatio(
  input: number,
  cacheRead: number,
  cacheCreation: number,
): number | undefined {
  const total = (input || 0) + (cacheRead || 0) + (cacheCreation || 0);
  if (total <= 0) return undefined;
  return ((cacheRead || 0) / total) * 100;
}

/** 格式化成 "XX.X%"(一位小数);无可报时返回 undefined。 */
export function formatCacheHitRatio(
  input: number,
  cacheRead: number,
  cacheCreation: number,
): string | undefined {
  const r = cacheHitRatio(input, cacheRead, cacheCreation);
  return r === undefined ? undefined : `${r.toFixed(1)}%`;
}
