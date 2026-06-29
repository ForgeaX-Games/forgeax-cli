import { ImageGenClient, ImageGenOpts, ImageGenResult, ImageVendorError, decodeBase64Png, withRetry } from './_shared';

const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_MODEL = 'doubao-seedream-5-0-260128';

/**
 * Seedream (字节即梦 · ARK).  Primary 立绘 vendor.  China-region datacenter
 * keeps latency under 6s for 2K images and there's no per-minute rate-limit on
 * this org key.  Accepts plain Chinese prompts without translation.
 *
 * Request shape mirrors OpenAI Images but adds `watermark` and accepts a 4K
 * label.  Auth is Bearer.  Response = `{ data: [{ b64_json | url }] }`.
 */
export class SeedreamClient implements ImageGenClient {
  readonly vendor = 'seedream';
  private readonly apiKey: string | undefined;

  constructor(env: Record<string, string | undefined>) {
    this.apiKey = env.ARK_IMAGE_KEY ?? env.SEEDREAM_API_KEY;
  }

  isReady(): boolean { return Boolean(this.apiKey); }

  async generate(opts: ImageGenOpts): Promise<ImageGenResult> {
    if (!this.apiKey) throw new ImageVendorError(this.vendor, 401, 'missing ARK_IMAGE_KEY');
    const model = opts.modelOverride ?? DEFAULT_MODEL;
    // Seedream accepts 'WIDTHxHEIGHT' or one of '2k' / '3k' / '4k' (LOWERCASE)
    // AND enforces a minimum total pixel count of 3,686,400 (≈ 1920×1920).
    // Anything below that is rejected with HTTP 400 — so the user-facing '1k'
    // tier (768×1024 / 786 432 px) gets silently upgraded to '2k' here.
    // Callers who genuinely want a sub-2k image will land on Gemini via
    // the dispatcher's fallback chain instead.
    const sizeLabel = opts.size === '4k' ? '4k' : '2k';

    return withRetry(async () => {
      const body = {
        model,
        prompt: opts.prompt,
        response_format: 'b64_json' as const,
        size: sizeLabel,
        seed: -1,
        watermark: false,
        n: 1,
      };
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new ImageVendorError(this.vendor, r.status, `${r.status} ${r.statusText} :: ${txt.slice(0, 240)}`);
      }
      const j = (await r.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const d = j.data?.[0];
      if (!d) throw new ImageVendorError(this.vendor, 502, 'empty data array');
      if (d.b64_json) {
        return {
          pngBytes: decodeBase64Png(d.b64_json),
          mime: 'image/png',
          vendor: this.vendor,
          modelId: model,
          estimateUSD: 0.04,
        };
      }
      if (d.url) {
        const imgRes = await fetch(d.url);
        if (!imgRes.ok) throw new ImageVendorError(this.vendor, imgRes.status, 'failed to fetch hosted image');
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        return { pngBytes: buf, mime: 'image/png', vendor: this.vendor, modelId: model, estimateUSD: 0.04 };
      }
      throw new ImageVendorError(this.vendor, 502, 'response missing b64_json + url');
    }, { label: 'seedream' });
  }
}
