// image-gateway — plugin-facing image generation router.
//
// Stage D contract:
//   gateway.image.generate({prompt, role?, vendor?, size?, refImageBase64?})
//     → { pngBytes, mime, vendor, modelId, triedVendors, latencyMs }
//   gateway.image.registerVendor(vendor)
//   gateway.image.setRoleChain(role, [vendorName, ...])
//
// Why a registry instead of the legacy ImageDispatcher class:
//   New vendors (LiteLLM image-gen, future Replicate/SD self-hosted) want to
//   plug in without modifying dispatcher.ts. The registry is the SSOT; the
//   legacy ImageDispatcher façade now delegates here (see clients/dispatcher.ts).
//
// Role chains mirror what dispatcher.ts had:
//   - concept-art (立绘 / 三视图):   seedream → nano-banana → azure-gpt-image → litellm-images
//   - sprite-frame (行动小人):       nano-banana → azure-gpt-image → seedream → litellm-images
// LiteLLM image vendor is appended as last fallback so direct vendor keys still
// win the hot path; the proxy is the safety net + future migration target.

import type { ImageGenRequest, ImageGenResponse, ImageVendor } from './types';
import { ImageVendorError } from './clients/_shared';

export * from './types';

const vendors = new Map<string, ImageVendor>();
const roleChains = new Map<NonNullable<ImageGenRequest['role']>, string[]>();

/** Which vendor owns a given model id. Lets the gateway forward modelOverride
 *  only to the matching vendor and let fallbacks use their own defaults. */
const MODEL_VENDOR_OWNER: Record<string, string> = {
  'gpt-image-2': 'azure-gpt-image',
  'gpt-image-1': 'azure-gpt-image',
  'gemini-2.5-flash-image': 'nano-banana',
  'gemini-3-pro-image-preview': 'nano-banana',
  'gemini-3.1-flash-image-preview': 'nano-banana',
  'doubao-seedream-5-0-260128': 'seedream',
  'doubao-seedream-4-0-250828': 'seedream',
  'litellm-image': 'litellm-images',
};

/** Public so the shim can map iframe `body.model` → preferred vendor. */
export function vendorForModel(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  return MODEL_VENDOR_OWNER[model];
}

const DEFAULT_CHAINS: Record<NonNullable<ImageGenRequest['role']>, string[]> = {
  'concept-art': ['seedream', 'nano-banana', 'azure-gpt-image', 'litellm-images'],
  'sprite-frame': ['nano-banana', 'azure-gpt-image', 'seedream', 'litellm-images'],
};

function defaultChainFor(role: NonNullable<ImageGenRequest['role']>): string[] {
  return roleChains.get(role) ?? DEFAULT_CHAINS[role];
}

export function registerImageVendor(vendor: ImageVendor): void {
  vendors.set(vendor.name, vendor);
}

export function unregisterImageVendor(name: string): void {
  vendors.delete(name);
}

export function listImageVendors(): Array<{ name: string; ready: boolean }> {
  return Array.from(vendors.values()).map((v) => ({ name: v.name, ready: v.isReady() }));
}

export function setRoleChain(role: NonNullable<ImageGenRequest['role']>, chain: string[]): void {
  roleChains.set(role, chain);
}

export function resolveChain(req: ImageGenRequest): string[] {
  const role = req.role ?? 'concept-art';
  const natural = defaultChainFor(role);
  if (!req.vendor || !vendors.has(req.vendor)) return natural;
  return [req.vendor, ...natural.filter((id) => id !== req.vendor)];
}

export async function generateImage(req: ImageGenRequest): Promise<ImageGenResponse> {
  const chain = resolveChain(req);
  const tried: string[] = [];
  let lastErr: Error | undefined;
  const started = Date.now();
  // modelOverride is vendor-specific. Only forward it to the pinned vendor
  // (req.vendor or the model's owner per MODEL_VENDOR_OWNER); fallbacks use
  // their own default model. Otherwise nano-banana would forward `gpt-image-2`
  // to the Gemini API and 404, etc.
  const overrideOwner = req.vendor ?? (req.modelOverride ? MODEL_VENDOR_OWNER[req.modelOverride] : undefined);

  for (const name of chain) {
    const v = vendors.get(name);
    if (!v) continue;
    if (!v.isReady()) {
      tried.push(`${name}:no-key`);
      continue;
    }
    try {
      const r = await v.generate({
        prompt: req.prompt,
        size: req.size,
        refImageBase64: req.refImageBase64,
        modelOverride: name === overrideOwner ? req.modelOverride : undefined,
      });
      return {
        ...r,
        triedVendors: [...tried, name],
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      const code = e instanceof ImageVendorError ? `${name}:${e.status}` : `${name}:err`;
      tried.push(code);
      lastErr = e as Error;
      // eslint-disable-next-line no-console
      console.warn(`[image-gateway] ${code}: ${(e as Error).message.slice(0, 240)}`);
    }
  }
  const e = new Error(
    `all image vendors failed for role=${req.role ?? 'concept-art'}: ` +
    `${tried.join(', ')} :: ${lastErr?.message ?? 'no key configured'}`,
  ) as Error & { triedVendors: string[] };
  e.triedVendors = tried;
  throw e;
}

/** Test-only: wipe registry + role chains. */
export function _resetImageGateway(): void {
  vendors.clear();
  roleChains.clear();
}

// 注:`createImageGen` 不从本桶 re-export —— create-image-gen.ts 反过来要经
// clients/dispatcher import 本文件的 vendor 注册表,从桶再导出它会形成
// dispatcher→index→create-image-gen→dispatcher 运行时环。消费方(tools/registry)
// 直接从 './create-image-gen' 源文件 import。
