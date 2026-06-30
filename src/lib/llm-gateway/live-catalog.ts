// LiteLLM live model catalog probe with TTL cache.
//
// Stage B: Today `~/.forgeax/key/models.json` is the only catalog UI sees, so
// users can't pick anything LiteLLM proxy adds upstream (gpt-5.5, glm-5.1,
// gemini-3.5-flash etc — 33 ids today vs 18 on disk). list_models merges both,
// with disk metadata winning so contextWindow/reasoning/input stay accurate.
//
// Fetch is cached 60s per (baseUrl, key) tuple — model picker poll cadence is
// every few seconds, hammering LiteLLM that often would burn proxy budget for
// data that changes maybe once a day. Cache key includes apiKey so a key
// rotation doesn't serve stale 401-tainted results.
//
// Failure mode: any network/auth error → return [] so caller falls back to
// disk-only catalog. Never throws; surfaces a structured `lastError` to UI for
// diagnostics.

export interface LiveCatalogResult {
  ids: string[];
  fetchedAt: number;
  fromCache: boolean;
  source: 'live' | 'cache' | 'disabled' | 'error';
  error?: string;
}

export interface FetchLiveCatalogOpts {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Bypass cache (still updates it on success). */
  forceRefresh?: boolean;
}

interface CacheEntry {
  ids: string[];
  fetchedAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Test-only: drop all cached entries. */
export function _resetLiveCatalogCache(): void {
  cache.clear();
}

function cacheKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl}::${apiKey.slice(-6)}`;
}

export async function fetchLiveCatalog(opts: FetchLiveCatalogOpts = {}): Promise<LiveCatalogResult> {
  const baseUrl = (opts.baseUrl ?? process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? process.env.LITELLM_PROXY_KEY ?? '';
  const now = Date.now();

  if (!baseUrl || !apiKey) {
    return { ids: [], fetchedAt: now, fromCache: false, source: 'disabled' };
  }

  const key = cacheKey(baseUrl, apiKey);
  if (!opts.forceRefresh) {
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      return { ids: cached.ids, fetchedAt: cached.fetchedAt, fromCache: true, source: 'cache' };
    }
  }

  const fetcher = opts.fetcher ?? fetch;
  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetcher(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ids: [], fetchedAt: now, fromCache: false, source: 'error', error: `HTTP ${resp.status}` };
    }
    const body = await resp.json() as { data?: Array<{ id?: string }> };
    const ids = Array.isArray(body.data)
      ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    cache.set(key, { ids, fetchedAt: now });
    return { ids, fetchedAt: now, fromCache: false, source: 'live' };
  } catch (err) {
    return {
      ids: [],
      fetchedAt: now,
      fromCache: false,
      source: 'error',
      error: (err as Error).message || 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
