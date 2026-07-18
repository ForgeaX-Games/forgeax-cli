/**
 * model-catalog — 内核模型目录的编排层 resolver(中立,零内核知识)。
 *
 * 「某内核支持哪些模型」的真相在内核自己那里;本文件只实现回退链并如实
 * 标注命中层(`KernelModelCatalog.source`),绝不 import 任何具体内核实现
 * (DIP,与 resolve-kernel.ts 同姿态——经 agent-runtime 共享 registry 查找):
 *
 *   0. env 显式覆盖      FORGEAX_<ID>_MODELS / <ID>_MODELS(用户强制,最高优先)
 *   1. kernel.listModels()          ← 内核自定义获取,统一入口(CLI flag /
 *                                      stream-json 控制面 / JSON-RPC / HTTP 都在内核侧)
 *   2. last-known 盘缓存             ~/.forgeax/key/kernel-models-<id>.json
 *   3. kernel.fallbackModels        ← 内核作者声明的静态兜底
 *   4. 空态 { models: [], source: 'none', error }(UI 显示"目录不可用",不给假列表)
 *
 * 层 1 成功后幂等覆盖写 last-known(§6);上层失败原因保留在 `error` 里
 * 即使下层成功(降级可见,§9)。unknown kernelId 返回空态而非抛错——这是
 * UI 渲染查询路径;chat 路径的 loud KernelUnavailableError 语义不变。
 *
 * TTL 内存缓存沿用旧 models.ts 语义:60min 缺省、in-flight dedupe、
 * FORGEAX_DRIVER_MODEL_CACHE_TTL_MS 可调、cache key 含 env 覆盖值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKernel, KernelModelCatalog, KernelModelInfo } from '@forgeax/agent-runtime';
import { listAvailableKernels } from './resolve-kernel';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface ModelCatalogPathsCtx {
  paths: { user(): { keyDir(): string } };
}

// ─── env override(层 0) ─────────────────────────────────────────────

/** kernelId → env var 名:FORGEAX_CURSOR_AGENT_MODELS / CURSOR_AGENT_MODELS。 */
function envVarNames(kernelId: string): [string, string] {
  const stem = kernelId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return [`FORGEAX_${stem}_MODELS`, `${stem}_MODELS`];
}

function envOverride(kernelId: string): string[] {
  const [primary, alias] = envVarNames(kernelId);
  return splitModelList(process.env[primary] ?? process.env[alias]);
}

function splitModelList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── last-known 持久化(层 2) ────────────────────────────────────────

function lastKnownFile(ctx: ModelCatalogPathsCtx, kernelId: string): string {
  const safe = kernelId.replace(/[^a-z0-9._-]+/gi, '_');
  return join(ctx.paths.user().keyDir(), `kernel-models-${safe}.json`);
}

function readLastKnown(ctx: ModelCatalogPathsCtx, kernelId: string): KernelModelInfo[] {
  const file = lastKnownFile(ctx, kernelId);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { models?: unknown };
    if (!Array.isArray(raw.models)) return [];
    return raw.models.filter(
      (m): m is KernelModelInfo => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string',
    );
  } catch {
    return [];
  }
}

function writeLastKnown(ctx: ModelCatalogPathsCtx, kernelId: string, models: KernelModelInfo[]): void {
  try {
    const dir = ctx.paths.user().keyDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = { fetchedAt: new Date().toISOString(), models };
    writeFileSync(lastKnownFile(ctx, kernelId), JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch {
    /* best-effort — 持久化失败不影响本次返回 */
  }
}

// ─── 回退链本体 ──────────────────────────────────────────────────────

function toInfos(ids: string[]): KernelModelInfo[] {
  return ids.map((id) => ({ id }));
}

async function resolveUncached(
  kernel: AgentKernel,
  ctx: ModelCatalogPathsCtx,
): Promise<KernelModelCatalog> {
  // 层 0:env 显式覆盖。
  const env = envOverride(kernel.id);
  if (env.length > 0) return { models: toInfos(env), source: 'env' };

  let error: string | undefined;

  // 层 1:内核自定义(唯一的"真实获取"入口——各内核自己选传输方式)。
  if (kernel.listModels) {
    try {
      const res = await kernel.listModels();
      if (res.models.length > 0) {
        writeLastKnown(ctx, kernel.id, res.models);
        return { ...res, source: 'kernel', error: res.error ?? error };
      }
      error = res.error ?? `${kernel.id}.listModels() returned no models`;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  // 层 2:上次成功结果。
  const lastKnown = readLastKnown(ctx, kernel.id);
  if (lastKnown.length > 0) return { models: lastKnown, source: 'last-known', error };

  // 层 3:内核作者声明的静态表。
  if (kernel.fallbackModels && kernel.fallbackModels.length > 0) {
    return { models: toInfos(kernel.fallbackModels), source: 'static', error };
  }

  // 层 4:空态——宁空不假。
  return { models: [], source: 'none', error: error ?? `${kernel.id}: no model discovery configured` };
}

// ─── TTL 缓存(沿用旧 driverModelCache 语义) ─────────────────────────

const catalogCache = new Map<string, { expiresAt: number; value?: KernelModelCatalog; promise?: Promise<KernelModelCatalog> }>();

function ttlMs(): number {
  const raw = Number(process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(raw) ? raw : DEFAULT_TTL_MS;
}

function cacheKey(kernelId: string, ctx: ModelCatalogPathsCtx): string {
  const [primary, alias] = envVarNames(kernelId);
  return `${kernelId}\0${ctx.paths.user().keyDir()}\0${process.env[primary] ?? process.env[alias] ?? ''}`;
}

/** 主入口:kernelId → 目录(带 `cached` 标记供 driver 元数据透传)。 */
export async function resolveKernelModelCatalog(
  kernelId: string,
  ctx: ModelCatalogPathsCtx,
): Promise<KernelModelCatalog & { kernelDisplayName?: string; cached?: boolean }> {
  const kernels = listAvailableKernels();
  const kernel = kernels.find((k) => k.id === kernelId);
  if (!kernel) {
    return {
      models: [],
      source: 'none',
      error: `unknown kernel '${kernelId}' (available: ${kernels.map((k) => k.id).join(', ')})`,
    };
  }

  const ttl = ttlMs();
  if (ttl <= 0) {
    const value = await resolveUncached(kernel, ctx);
    return { ...value, kernelDisplayName: kernel.displayName };
  }

  const key = cacheKey(kernelId, ctx);
  const now = Date.now();
  const hit = catalogCache.get(key);
  if (hit?.value && hit.expiresAt > now) {
    return { ...hit.value, kernelDisplayName: kernel.displayName, cached: true };
  }
  if (hit?.promise) {
    return { ...(await hit.promise), kernelDisplayName: kernel.displayName, cached: true };
  }

  const promise = resolveUncached(kernel, ctx);
  catalogCache.set(key, { expiresAt: now + ttl, promise });
  try {
    const value = await promise;
    catalogCache.set(key, { expiresAt: Date.now() + ttl, value });
    return { ...value, kernelDisplayName: kernel.displayName };
  } catch (err) {
    catalogCache.delete(key);
    throw err;
  }
}

/** Test-only:清缓存。 */
export function _resetModelCatalogCache(): void {
  catalogCache.clear();
}
