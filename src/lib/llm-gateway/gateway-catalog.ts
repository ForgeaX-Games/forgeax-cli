// gateway-catalog — LLM gateway(LiteLLM proxy)路径的模型 catalog 合并逻辑。
//
// 从 builtin/commands/models.ts 下沉(模型目录内核化改造):同一份实现供多个
// 入口消费(SSOT)——
//   1. commands `list_models`(无 providerId 参数 = gateway 目录)
//   2. forgeax-core 原生内核的 `listModels()` —— 两份实现都经
//      `gatewayCatalogToKernelModels()` 收口:server 侧 product shell 的
//      `server/src/kernel/forgeax-core-adapter.ts`(实际注册那份)+ cli 侧
//      standalone tarball 的 `kernel/forgeax-core-kernel.ts`。
//
// 语义(原样保留):live `/v1/models` 是「哪些 id 真的能路由」的 SSOT,盘上
// `~/.forgeax/key/models.json` 只补元数据(contextWindow / reasoning / input)。
// live 权威时取交集(盘上 proxy 已下架的条目丢弃,点它只会 400);live-only id
// 用 LIVE_DEFAULT_SPEC 兜底。离线/无凭证 → 全量盘目录(§9 graceful degradation)。
// 展示顺序按「强度」排(claude 族最前 → 版本降序 → tier),不按文件顺序。

import { existsSync, readFileSync } from "node:fs";
import type { KernelModelCatalog } from "@forgeax/agent-runtime";
import { fetchLiveCatalog } from "./live-catalog";
import { getPathManager } from "../../fs/path-manager";

export interface GatewayPathsCtx {
  paths: { user(): { modelsFile(): string } };
}

export interface GatewayCatalogRow extends Record<string, unknown> {
  id: string;
  /** 元数据来源:'disk' = 命中 models.json 富元数据;'live' = 默认 spec 兜底。 */
  source?: string;
  /** 该 id 当前是否由 live proxy 提供(live 权威时整份统一 true)。 */
  live: boolean;
}

export interface GatewayCatalogResult {
  models: GatewayCatalogRow[];
  live: { source: string; error?: string; ids: number };
}

/** Default spec for models LiteLLM proxy advertises but disk hasn't annotated.
 *  Mirrors src/llm/provider.ts:DEFAULT_SPEC so UI doesn't see a different
 *  baseline depending on whether a model is "known" yet. */
const LIVE_DEFAULT_SPEC = {
  input: ["text"],
  reasoning: false,
  contextWindow: 128000,
  maxOutput: 4096,
  defaultTemperature: 0.7,
  source: "live" as const,
};

/** Read `~/.forgeax/key/models.json` —— 每次调都重读盘,user 编辑后无需重启。
 *  与 src/llm/provider.ts:loadModelCatalog 共享语义(同一份文件,不缓存)。 */
export function loadDiskCatalog(ctx?: GatewayPathsCtx): Record<string, Record<string, unknown>> {
  const file = (ctx?.paths ?? getPathManager()).user().modelsFile();
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, spec] of Object.entries(raw)) {
      if (spec && typeof spec === "object" && !Array.isArray(spec)) {
        out[id] = spec as Record<string, unknown>;
      } else {
        out[id] = { spec };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Strength ordering for the picker — strongest model first.
 *  Strength is NOT losslessly derivable from an id (a "5" isn't always stronger
 *  than a "4.8" across tiers), so family + tier priority are **authored** here —
 *  edit these arrays to re-rank. Within a family: version descending, then tier
 *  (opus > sonnet > haiku), then a base id before its dated / vendor / size
 *  variants. */
const FAMILY_RANK: Array<[RegExp, number]> = [
  [/^claude/, 0],
  [/^gemini/, 1],
  [/^(gpt|codex)/, 2],
  [/^deepseek/, 3],
];
const TIER_RANK: Array<[string, number]> = [
  ["fable", 0], ["opus", 1], ["sonnet", 2], ["haiku", 3],
];
/** dated (-20260320) / vendor (-bedrock,-openai) / thinking / size (-mini,-lite)
 *  / channel (-preview,-fast,-image) suffixes mark a variant of a base model —
 *  the plain base id sorts first. */
const VARIANT_RE = /-\d{6,}|-bedrock|-openai|-thinking|-mini|-lite|-preview|-fast|-image/;

/** Comparator key: [familyRank, -major, -minor, tierRank, isVariant, id]. */
function strengthKey(id: string): [number, number, number, number, number, string] {
  const s = id.toLowerCase();
  let family = 50; // unknown families after the known ones
  for (const [re, r] of FAMILY_RANK) if (re.test(s)) { family = r; break; }
  const m = s.match(/(\d+)(?:[.-](\d+))?/); // first "4-8" | "4.8" | "3.1" | "v4" | "5"
  const major = m ? Number(m[1]) : 0;
  const minor = m && m[2] != null ? Number(m[2]) : 0;
  let tier = 9;
  for (const [k, r] of TIER_RANK) if (s.includes(k)) { tier = r; break; }
  const variant = VARIANT_RE.test(s) ? 1 : 0;
  return [family, -major, -minor, tier, variant, s];
}

export function byStrength(a: { id: string }, b: { id: string }): number {
  const ka = strengthKey(a.id);
  const kb = strengthKey(b.id);
  for (let i = 0; i < 5; i++) {
    const d = (ka[i] as number) - (kb[i] as number);
    if (d) return d;
  }
  return (ka[5] as string).localeCompare(kb[5] as string);
}

/** Merge disk catalog with LiteLLM proxy live `/v1/models`(语义见文件头)。 */
export async function loadGatewayCatalog(ctx?: GatewayPathsCtx): Promise<GatewayCatalogResult> {
  const disk = loadDiskCatalog(ctx);
  const live = await fetchLiveCatalog();

  const liveAuthoritative = live.source === "live" || live.source === "cache";
  const liveSet = new Set(live.ids);

  const seen = new Set<string>();
  const out: GatewayCatalogRow[] = [];

  for (const [id, spec] of Object.entries(disk)) {
    if (liveAuthoritative && !liveSet.has(id)) continue;
    out.push({ id, source: "disk", ...spec, live: liveAuthoritative });
    seen.add(id);
  }
  for (const id of live.ids) {
    if (seen.has(id)) continue;
    out.push({ id, ...LIVE_DEFAULT_SPEC, live: liveAuthoritative });
    seen.add(id);
  }

  out.sort(byStrength);

  return {
    models: out,
    live: { source: live.source, error: live.error, ids: live.ids.length },
  };
}

/** Map a gateway catalog → KernelModelCatalog for the forgeax-core native
 *  kernel. SSOT: both the cli kernel (forgeax-core-kernel) and the server
 *  adapter (forgeax-core-adapter) delegate here — one map-and-wrap.
 *
 *  §9 graceful degradation stays VISIBLE: the native kernel routes via the
 *  gateway so `source` is 'kernel', but when the live proxy isn't authoritative
 *  (`disabled`/`error` → the rows are the offline disk catalog) we surface WHY
 *  even though a `disabled` gateway carries no `error` string of its own —
 *  otherwise the picker would show an authoritative-looking list with no hint
 *  it's stale. */
export function gatewayCatalogToKernelModels(res: GatewayCatalogResult): KernelModelCatalog {
  const { models, live } = res;
  const authoritative = live.source === "live" || live.source === "cache";
  return {
    models: models.map((m) => ({
      id: m.id,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
      input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
    })),
    source: "kernel",
    error: live.error ?? (authoritative ? undefined : `gateway ${live.source} — showing offline disk catalog`),
  };
}
