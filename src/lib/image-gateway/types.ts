// Stage D — image-gateway plugin-facing types.
//
// Reuses the existing character-forge ImageGenOpts / ImageGenResult shape so
// vendor clients (Seedream / Gemini / Azure) plug straight in. ImageVendor is
// the gateway's registry record — a tiny strict subset of the legacy
// ImageGenClient interface, plus an optional priority weight.

export interface ImageGenRequest {
  prompt: string;
  size?: '1k' | '2k' | '4k';
  refImageBase64?: string | null;
  /** Override vendor's default model id (e.g. doubao-seedream-5-0-260128). */
  modelOverride?: string;
  /** Role drives which chain the gateway walks (concept-art vs sprite-frame). */
  role?: 'concept-art' | 'sprite-frame';
  /** Explicit vendor pin — gateway tries this first, then falls back to role chain. */
  vendor?: string;
}

export interface ImageGenResponse {
  pngBytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  vendor: string;
  modelId: string;
  estimateUSD: number;
  /** Ordered list of vendors the gateway attempted before this one (debug aid). */
  triedVendors: string[];
  latencyMs: number;
}

export interface ImageVendor {
  readonly name: string;
  isReady(): boolean;
  generate(req: Omit<ImageGenRequest, 'role' | 'vendor'>): Promise<{
    pngBytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg' | 'image/webp';
    vendor: string;
    modelId: string;
    estimateUSD: number;
  }>;
}
