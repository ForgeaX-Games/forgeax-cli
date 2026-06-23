export interface ImageGenOpts {
  prompt: string;
  size?: '1k' | '2k' | '4k';
  refImageBase64?: string | null;
  /** override 的 vendor 模型 id (e.g. doubao-seedream-5-0-260128). 不传走默认. */
  modelOverride?: string;
}

export interface ImageGenResult {
  pngBytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  vendor: string;
  modelId: string;
  estimateUSD: number;
}

export interface ImageGenClient {
  readonly vendor: string;
  /** key configured / vendor 可用 → 才返 true */
  isReady(): boolean;
  generate(opts: ImageGenOpts): Promise<ImageGenResult>;
}

export class ImageVendorError extends Error {
  constructor(public vendor: string, public status: number, message: string) {
    super(`[${vendor}] ${message}`);
    this.name = 'ImageVendorError';
  }
}

/**
 * `withRetry` —— exponential backoff for transient image-API failures.
 * 5xx / 429 / network ECONNRESET retried up to `attempts-1` times; everything
 * else propagates immediately. The caller's catch is responsible for stepping
 * down to a fallback vendor.
 *
 * Why bespoke instead of `p-retry`: we'd otherwise drag a transitive dep into
 * a plugin that has zero `node_modules`. Backoff is dumb but deterministic for
 * tests (mock Date.now if needed).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 350;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isVendor = e instanceof ImageVendorError;
      const retriable = !isVendor || e.status === 429 || (e.status >= 500 && e.status < 600);
      if (!retriable || i === attempts - 1) throw e;
      const wait = base * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export function decodeBase64Png(b64: string): Uint8Array {
  // Strip the `data:image/...;base64,` prefix when present so callers can pass
  // either the raw payload or the data-URL form returned by some browsers.
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  return Uint8Array.from(Buffer.from(clean, 'base64'));
}

export function sizeToWxH(size: '1k' | '2k' | '4k' | undefined): { w: number; h: number; label: string } {
  switch (size) {
    case '4k': return { w: 2160, h: 3840, label: '2160x3840' };
    case '1k': return { w: 768, h: 1024, label: '768x1024' };
    case '2k':
    default:  return { w: 1024, h: 1536, label: '1024x1536' };
  }
}
