import { ImageGenClient, ImageGenOpts, ImageGenResult, ImageVendorError, decodeBase64Png, withRetry } from './_shared';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini "nano-banana".  Primary sprite-sheet vendor + portrait fallback.
 *
 * Two reasons it owns the sprite path: (a) accepts a reference image in the
 * same prompt → keeps the character recognisable across all sheet cells;
 * (b) the multi-modality `responseModalities: ["IMAGE"]` switch is honoured
 * even when the prompt is long & structured (Seedream sometimes truncates).
 *
 * Key is passed in the URL `?key=` (Google AI Studio convention) — no header
 * trick will work, the v1beta route only reads the query param.
 */
export class GeminiImageClient implements ImageGenClient {
  readonly vendor = 'gemini-image';
  private readonly apiKey: string | undefined;

  constructor(env: Record<string, string | undefined>) {
    this.apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_GEN_AI_KEY;
  }

  isReady(): boolean { return Boolean(this.apiKey); }

  async generate(opts: ImageGenOpts): Promise<ImageGenResult> {
    if (!this.apiKey) throw new ImageVendorError(this.vendor, 401, 'missing GEMINI_API_KEY');
    const model = opts.modelOverride ?? DEFAULT_MODEL;
    const url = `${BASE}/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }];
    if (opts.refImageBase64) {
      const clean = opts.refImageBase64.replace(/^data:[^;]+;base64,/, '');
      parts.unshift({ inlineData: { mimeType: 'image/png', data: clean } });
    }

    return withRetry(async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['IMAGE'], candidateCount: 1 },
        }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new ImageVendorError(this.vendor, r.status, `${r.status} ${r.statusText} :: ${txt.slice(0, 240)}`);
      }
      const j = (await r.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
      };
      const inline = j.candidates?.[0]?.content?.parts?.find((p) => p?.inlineData?.data)?.inlineData;
      if (!inline?.data) {
        throw new ImageVendorError(this.vendor, 502, 'no inlineData in response');
      }
      return {
        pngBytes: decodeBase64Png(inline.data),
        mime: (inline.mimeType as 'image/png' | undefined) ?? 'image/png',
        vendor: this.vendor,
        modelId: model,
        estimateUSD: 0.03,
      };
    }, { label: 'gemini-image' });
  }
}
