// LiteLLM proxy `/v1/images/generations` vendor.
//
// Today (2026-05-21) the configured LITELLM_PROXY_BASE_URL has no image
// models registered — /v1/models returns text-only ids. So this vendor reports
// isReady()=false unless `LITELLM_PROXY_IMAGE_MODEL` is set, meaning a
// deployment that *does* enable image routing can flip it on with one env
// var, no code change.
//
// Wire shape mirrors OpenAI /v1/images/generations:
//   POST { model, prompt, n=1, size, response_format:'b64_json' }
//   → { data: [{ b64_json: "..." }] }
// The proxy adapts to upstream (Seedream / Imagen / DALL-E / SDXL) so the
// gateway doesn't need per-vendor branching here.

import type { ImageVendor } from '../types';

const PRICE_PLACEHOLDER_USD = 0.04; // Proxy doesn't report price; UI shows estimate.

interface LiteLLMImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

export interface LitellmImagesOpts {
  baseUrl?: string;
  apiKey?: string;
  /** Default model id to send — set via LITELLM_PROXY_IMAGE_MODEL env in prod. */
  defaultModel?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export function createLitellmImagesVendor(opts: LitellmImagesOpts = {}): ImageVendor {
  const baseUrl = (opts.baseUrl ?? process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? process.env.LITELLM_PROXY_KEY ?? '';
  const defaultModel = opts.defaultModel ?? process.env.LITELLM_PROXY_IMAGE_MODEL ?? '';
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    name: 'litellm-images',
    isReady() {
      return !!(baseUrl && apiKey && defaultModel);
    },
    async generate(req) {
      const model = req.modelOverride ?? defaultModel;
      if (!model) throw new Error('litellm-images: no model configured (set LITELLM_PROXY_IMAGE_MODEL)');
      if (!baseUrl) throw new Error('litellm-images: LITELLM_PROXY_BASE_URL not set');
      if (!apiKey) throw new Error('litellm-images: LITELLM_PROXY_KEY not set');

      const sizeMap = { '1k': '1024x1024', '2k': '1024x1536', '4k': '2048x2048' } as const;
      const size = sizeMap[req.size ?? '2k'];

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
      try {
        const resp = await fetcher(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: req.prompt,
            n: 1,
            size,
            response_format: 'b64_json',
          }),
          signal: ctrl.signal,
        });
        const raw = await resp.text();
        let parsed: LiteLLMImageResponse;
        try { parsed = JSON.parse(raw) as LiteLLMImageResponse; }
        catch { throw new Error(`litellm-images: non-JSON (HTTP ${resp.status}): ${raw.slice(0, 200)}`); }
        if (!resp.ok) {
          throw new Error(`litellm-images: ${parsed.error?.message ?? `HTTP ${resp.status}`}`);
        }
        const b64 = parsed.data?.[0]?.b64_json;
        if (!b64) throw new Error('litellm-images: response missing data[0].b64_json');
        const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
        // mime sniff (PNG signature; OpenAI image API returns PNG by default)
        const mime: 'image/png' | 'image/jpeg' | 'image/webp' =
          (bytes[0] === 0xff && bytes[1] === 0xd8) ? 'image/jpeg' : 'image/png';
        return {
          pngBytes: bytes,
          mime,
          vendor: 'litellm-images',
          modelId: model,
          estimateUSD: PRICE_PLACEHOLDER_USD,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
