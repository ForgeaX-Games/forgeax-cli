import { ImageGenClient, ImageGenOpts, ImageGenResult, ImageVendorError, decodeBase64Png, sizeToWxH, withRetry } from './_shared';

const DEFAULT_DEPLOYMENT = 'gpt-image-2';
const API_VERSION = '2024-02-01';

/**
 * Azure-hosted gpt-image-2.  Secondary vendor for both立绘 (when Seedream errors
 * 429/5xx) and sprite-sheets (when Gemini drops responseModalities=IMAGE).
 *
 * Auth = header `api-key` (NOT `Authorization: Bearer` despite the OpenAI
 * shape — Azure stamps its own scheme).  Sizes restricted to
 * 1024x1024 / 1024x1536 / 1536x1024; we map our 1k/2k/4k label set onto the
 * closest legal cell, falling back to portrait 1024x1536 when 4K is requested
 * because Azure doesn't go higher than 1536 on either axis.
 *
 * Endpoint must be supplied via `AZURE_GPT_IMAGE_ENDPOINT`.  No hardcoded
 * default — vendor reports `isReady()=false` until both key and endpoint are
 * configured, so deployments without Azure access never accidentally route
 * here.
 */
export class AzureGptImageClient implements ImageGenClient {
  readonly vendor = 'azure-gpt-image';
  private readonly apiKey: string | undefined;
  private readonly endpoint: string | undefined;
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly editApiVersion: string;

  constructor(env: Record<string, string | undefined>) {
    this.apiKey = env.AZURE_GPT_IMAGE_KEY;
    this.endpoint = env.AZURE_GPT_IMAGE_ENDPOINT;
    this.deployment = env.AZURE_GPT_IMAGE_DEPLOYMENT ?? DEFAULT_DEPLOYMENT;
    this.apiVersion = env.AZURE_GPT_IMAGE_API_VERSION ?? API_VERSION;
    // /images/edits 需要更新的预览版 API;与 /generations 分开配置。
    this.editApiVersion = env.AZURE_GPT_IMAGE_EDIT_API_VERSION ?? this.apiVersion;
  }

  isReady(): boolean { return Boolean(this.apiKey && this.endpoint); }

  async generate(opts: ImageGenOpts): Promise<ImageGenResult> {
    if (!this.apiKey) throw new ImageVendorError(this.vendor, 401, 'missing AZURE_GPT_IMAGE_KEY');
    if (!this.endpoint) throw new ImageVendorError(this.vendor, 400, 'missing AZURE_GPT_IMAGE_ENDPOINT');
    const { w, h } = sizeToWxH(opts.size);
    const cappedW = Math.min(w, 1536);
    const cappedH = Math.min(h, 1536);

    // 关键:有参考图时必须走 /images/edits(多部件、把图作为条件),否则
    // gpt-image-2 会无视参考图、纯按 prompt 重画一个全新角色 —— 这正是
    // "四方向跟我的角色设计毫无关联" 的根因。无参考图时才退回 /generations。
    const ref = opts.refImageBase64?.replace(/^data:[^;]+;base64,/, '') || '';
    if (ref) {
      return this.generateWithReference(ref, opts.prompt, cappedW, cappedH);
    }
    return this.generateFromText(opts.prompt, cappedW, cappedH);
  }

  private async generateFromText(prompt: string, w: number, h: number): Promise<ImageGenResult> {
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/images/generations?api-version=${this.apiVersion}`;
    return withRetry(async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': this.apiKey!, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, size: `${w}x${h}`, n: 1 }),
      });
      return this.parseImageResponse(r);
    }, { label: 'azure-gpt-image' });
  }

  /**
   * Image-conditioned generation via the gpt-image `/images/edits` endpoint.
   * Sends the reference (upstream design portrait) as a multipart `image[]`
   * field so the model keeps the character recognisable across the four-view
   * turnaround / sprite frames, instead of inventing a new character.
   */
  private async generateWithReference(
    refBase64: string,
    prompt: string,
    w: number,
    h: number,
  ): Promise<ImageGenResult> {
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/images/edits?api-version=${this.editApiVersion}`;
    // gpt-image edits 只接受固定档位:1024x1024 / 1024x1536 / 1536x1024。
    // 把任意 w/h 吸附到最接近的合法档位(按宽高比选竖/方/横)。
    const size = snapToGptImageSize(w, h);
    return withRetry(async () => {
      const bytes = Uint8Array.from(Buffer.from(refBase64, 'base64'));
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('n', '1');
      // gpt-image edits 接受 image[](可多张参考图);这里给单张上游设计图。
      const blob = new Blob([bytes], { type: 'image/png' });
      form.append('image[]', blob, 'reference.png');
      const r = await fetch(url, {
        method: 'POST',
        // 不要手动设 content-type:让 fetch 自动带上 multipart boundary。
        headers: { 'api-key': this.apiKey! },
        body: form,
      });
      return this.parseImageResponse(r);
    }, { label: 'azure-gpt-image-edits' });
  }

  private async parseImageResponse(r: Response): Promise<ImageGenResult> {
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new ImageVendorError(this.vendor, r.status, `${r.status} ${r.statusText} :: ${txt.slice(0, 240)}`);
    }
    const j = (await r.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw new ImageVendorError(this.vendor, 502, 'no b64_json in response');
    return {
      pngBytes: decodeBase64Png(b64),
      mime: 'image/png',
      vendor: this.vendor,
      modelId: this.deployment,
      estimateUSD: 0.05,
    };
  }
}

/** gpt-image 合法尺寸只有方/竖/横三档;按宽高比吸附到最近的一档。 */
function snapToGptImageSize(w: number, h: number): '1024x1024' | '1024x1536' | '1536x1024' {
  const ratio = w / Math.max(1, h);
  if (ratio > 1.15) return '1536x1024';   // 横向
  if (ratio < 0.87) return '1024x1536';   // 竖向
  return '1024x1024';                       // 接近方形
}
