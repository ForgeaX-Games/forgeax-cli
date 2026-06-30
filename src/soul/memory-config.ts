/**
 * 记忆开关配置(持久化 SSOT)—— Studio 设置页读写、runAutoExtract 据此 gate。
 *
 * 落 `<projectRoot>/.forgeax/memory-settings.json`,形态 = `@forgeax/types` 的 MemorySwitchConfig
 * (master + perKernel)。能力位(cacheWarmCapable)从内核 registry 的 `capabilities.forkExtract`
 * 派生,**不入持久化**(派生量,SSOT 在内核)。生效解析复用 types 的 `memoryAutoExtractEnabled`。
 *
 * Boundary(HOST 层):node: + @forgeax/{types,agent-runtime,platform-io}。
 */
import {
  defaultMemorySwitchConfig,
  memoryAutoExtractEnabled,
  type MemorySwitchConfig,
} from '@forgeax/types';
import { listKernels, getKernel } from '@forgeax/agent-runtime';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

function cfgPath(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax', 'memory-settings.json');
}

/** perKernel 覆盖项的 fail-fast 净化:仅保留布尔值。非布尔(如字符串 "false" / 数字 1)会绕过
 *  `memoryAutoExtractEnabled` 的 `override ?? 默认` 被当 truthy → 反转用户意图;故在外部 JSON
 *  入口(PUT body)与磁盘读回(readMemorySwitch)统一剔除,净化口径 SSOT 在此一处。 */
export function coercePerKernel(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** 读持久化开关配置;不存在/损坏 → 默认(master:true,无覆盖)。 */
export function readMemorySwitch(projectRoot: string = defaultProjectRoot()): MemorySwitchConfig {
  try {
    const p = cfgPath(projectRoot);
    if (!existsSync(p)) return defaultMemorySwitchConfig();
    const j = JSON.parse(readFileSync(p, 'utf-8')) as Partial<MemorySwitchConfig>;
    return {
      master: typeof j.master === 'boolean' ? j.master : true,
      perKernel: coercePerKernel(j.perKernel),
    };
  } catch {
    return defaultMemorySwitchConfig();
  }
}

/** 写开关配置。 */
export function writeMemorySwitch(cfg: MemorySwitchConfig, projectRoot: string = defaultProjectRoot()): void {
  const p = cfgPath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ master: cfg.master, perKernel: cfg.perKernel }, null, 2));
}

/** 列出已注册内核 + 其 cache-warm 能力(forkExtract)。供设置页渲染分模型开关 + 省/不省token标。 */
export function listKernelCacheCaps(): Array<{ id: string; cacheWarmCapable: boolean }> {
  return listKernels().map((k) => ({ id: String(k.id), cacheWarmCapable: !!k.capabilities?.forkExtract }));
}

/** 生效解析:某内核是否跑 auto-extract(master && perKernel[?] ?? 按能力位默认)。 */
export function autoExtractEnabledFor(kernelId: string, projectRoot: string = defaultProjectRoot()): boolean {
  const cfg = readMemorySwitch(projectRoot);
  const k = getKernel(kernelId);
  const warm = !!k?.capabilities?.forkExtract;
  return memoryAutoExtractEnabled(cfg, kernelId, warm);
}
