import type { Usage } from './types';

/** Providers reporting a total prompt (including cache) must use additive Usage buckets. */
export function tokenCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value) : undefined;
}

export function inclusiveInputUsage(total: unknown, cached: unknown): Partial<Usage> {
  const prompt = tokenCounter(total);
  const read = tokenCounter(cached);
  // A cache-only partial frame cannot establish the uncached portion.
  if (prompt === undefined) return {};
  const cache = Math.min(prompt, read ?? 0);
  return { inputTokens: prompt - cache, cacheReadInputTokens: cache };
}
