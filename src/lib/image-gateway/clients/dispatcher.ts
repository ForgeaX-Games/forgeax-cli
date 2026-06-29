// `ImageDispatcher` — thin façade over the new lib/image-gateway registry.
//
// Stage D refactor: the SSOT for image vendor selection is now
// `lib/image-gateway/`. This file is kept so handlers.ts doesn't change shape
// (it still does `new ImageDispatcher(ctx.env).generate('concept-art', opts)`),
// but every call routes through the gateway, picking up any vendors plugins
// register at runtime (including the new litellm-images proxy adapter).
//
// Role chains and the preferred-vendor override behavior match the legacy
// behavior bit-for-bit so callers / tests don't notice the swap.

import { SeedreamClient } from './seedream';
import { GeminiImageClient } from './gemini-image';
import { AzureGptImageClient } from './azure-gpt-image';
import type { ImageGenOpts, ImageGenResult, ImageGenClient } from './_shared';
import {
  registerImageVendor,
  unregisterImageVendor,
  generateImage,
  listImageVendors,
  type ImageVendor,
} from '../index';
import { createLitellmImagesVendor } from '../vendors/litellm-images';

export type ChannelRole = 'concept-art' | 'sprite-frame';

export interface DispatchResult extends ImageGenResult {
  triedVendors: string[];
}

/** Adapt a character-forge ImageGenClient to the gateway's ImageVendor shape.
 *  `registryName` is the canonical wire-level name used in plugin schemas
 *  (forgeax-plugin.json + generate-portrait.args.json) and role chains — it may
 *  differ from the client's internal `vendor` field (e.g. 'nano-banana' for
 *  GeminiImageClient whose vendor is 'gemini-image'). */
function adapt(client: ImageGenClient, registryName: string): ImageVendor {
  return {
    name: registryName,
    isReady: () => client.isReady(),
    generate: (req) => client.generate(req as ImageGenOpts),
  };
}

export class ImageDispatcher {
  private readonly vendorNames: string[];

  constructor(env: Record<string, string | undefined>) {
    // Each new dispatcher re-registers vendors with this env. Vendors are keyed
    // by name (idempotent overwrite), so the latest ctx.env wins — matches the
    // old WeakMap<HandlerCtx> caching behavior in handlers.ts.
    const vendors: ImageVendor[] = [
      adapt(new SeedreamClient(env), 'seedream'),
      adapt(new GeminiImageClient(env), 'nano-banana'),
      adapt(new AzureGptImageClient(env), 'azure-gpt-image'),
      createLitellmImagesVendor({
        baseUrl: env.LITELLM_PROXY_BASE_URL,
        apiKey: env.LITELLM_PROXY_KEY,
        defaultModel: env.LITELLM_PROXY_IMAGE_MODEL,
      }),
    ];
    for (const v of vendors) registerImageVendor(v);
    this.vendorNames = vendors.map((v) => v.name);
  }

  isReady(): { ready: string[]; missing: string[] } {
    const ready: string[] = [];
    const missing: string[] = [];
    for (const v of listImageVendors()) {
      if (!this.vendorNames.includes(v.name)) continue;
      (v.ready ? ready : missing).push(v.name);
    }
    return { ready, missing };
  }

  async generate(
    role: ChannelRole,
    opts: ImageGenOpts,
    preferred?: string,
  ): Promise<DispatchResult> {
    const resp = await generateImage({
      prompt: opts.prompt,
      size: opts.size,
      refImageBase64: opts.refImageBase64,
      modelOverride: opts.modelOverride,
      role,
      vendor: preferred,
    });
    return {
      pngBytes: resp.pngBytes,
      mime: resp.mime,
      vendor: resp.vendor,
      modelId: resp.modelId,
      estimateUSD: resp.estimateUSD,
      triedVendors: resp.triedVendors,
    };
  }

  /** Test helper: drop the vendors this dispatcher registered (lets later
   *  tests start from a known-empty gateway). */
  dispose(): void {
    for (const n of this.vendorNames) unregisterImageVendor(n);
  }
}
