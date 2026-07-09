// @desc Command module: models — 模型 catalog + per-agent 模型选择查询 / 写入
//
// 路线：agent.json::models.model 是 LLM fallback 链（`string | string[] | null`，
// resolve-models 顺序消费）。本模块把它作为 commands 系统的唯一入口：
//
//   list_models        无参数                                                  hasQuery
//   get_agent_model    args[0]=sid, args[1]=agentPath                          hasQuery
//   set_agent_models   args[0]=sid, args[1]=agentPath, args[2..]=model…        hasExecute
//
// list_models 直接读 `~/.forgeax/key/models.json` —— provider.ts 里的
// loadModelCatalog 是 server 端 LLM 路由的真相源，UI model picker 拿它的同一份
// 数据保证不漂移（user 编辑 models.json 后下一次 list_models 自动看见）。
//
// 设计要点：
// - 永远以**数组形态**对外暴露（chain）；同时给一个 `selected = chain[0] ?? null`，
//   让 UI 只想拿当前生效模型时不必判断 string / array / 缺省。
// - get 直接读盘上 agent.json 的真实字段（不经 AGENT_DEFAULTS deep-merge），
//   能区分「用户没配」与「显式 null」。
// - set 把 model 写成 string[]（单模型也是 ["MODEL"]）；保留 models 里其它字段
//   （temperature / maxRetries / routing 等）。
// - 走 paths.session(sid).agent(agentPath).agentJson() 拿真实文件路径；isValidAgentPath
//   防 ../ 越界 + tree 节点存在校验防对一个不存在的 agent 写盘。
// - 已在跑的 agent 构造时吃了一份 agentJson 快照；set 末尾 controlAgent("restart")
//   让 factory 重读盘。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandModule } from "../../src/commands/types";
import { isValidAgentPath } from "../../src/core/agent-scaffold";
import { fetchLiveCatalog } from "../../src/lib/llm-gateway/live-catalog";
import { runCapture } from "../../src/lib/node-spawn";
import { resolveBinary } from "../../src/cli-providers/shared/resolve-binary";

interface ReadModelArgs {
  sid: string;
  agentPath: string;
}

function parseAgentArgs(name: string, args: string[]): ReadModelArgs {
  const sid = (args[0] ?? "").trim();
  const agentPath = (args[1] ?? "").trim();
  if (!sid) throw new Error(`${name}: args[0] (sid) required`);
  if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
  if (!isValidAgentPath(agentPath)) {
    throw new Error(`${name}: invalid agentPath '${agentPath}' (must match name(/agents/name)*)`);
  }
  return { sid, agentPath };
}

/** Read raw agent.json from disk —— **不**经 AGENT_DEFAULTS deep-merge，让 caller
 *  能区分「用户没配 models 字段」（chain=[]、raw=null）与「显式空 chain」
 *  （chain=[]、raw=[]）。 */
function readAgentJsonRaw(file: string, cmd: string): Record<string, unknown> {
  if (!existsSync(file)) {
    throw new Error(`${cmd}: agent.json missing at ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${cmd}: agent.json parse failed: ${(err as Error).message}`);
  }
}

/** 把 agent.json::models.model 三种形态（string | string[] | null/缺省）
 *  归一成 fallback chain string[]，并算出当前生效模型（chain[0]）。 */
function normalizeModel(raw: unknown): { chain: string[]; selected: string | null } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { chain: [trimmed], selected: trimmed } : { chain: [], selected: null };
  }
  if (Array.isArray(raw)) {
    const chain = raw
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    return { chain, selected: chain[0] ?? null };
  }
  return { chain: [], selected: null };
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

const CURSOR_DRIVER_LABEL = "cursor-agent · subscription runtime · no local cost";
const CLAUDE_CODE_DRIVER_LABEL = "claude-code · subscription runtime · no local cost";
const CODEX_DRIVER_LABEL = "codex · subscription runtime · no local cost";
const CODEBUDDY_DRIVER_LABEL = "codebuddy · subscription runtime · no local cost";
const CURSOR_FALLBACK_MODELS = [
  "gpt-5.5-medium",
  "gpt-5.1-codex-max-medium",
  "claude-opus-4-8-thinking-high",
  "claude-sonnet-4-6-thinking",
];
const CLAUDE_CODE_FALLBACK_MODELS = [
  "opus",
  "sonnet",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-4.6-sonnet-medium",
];
const CODEX_FALLBACK_MODELS = [
  "gpt-5.2",
  "gpt-5.1-codex-max-medium",
  "gpt-5.4-mini-medium",
  "gpt-5-mini",
];
const CODEBUDDY_FALLBACK_MODELS = [
  "default-model",
  "gemini-3.1-pro",
  "gemini-3.0-flash",
  "gemini-3.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "deepseek-v3-2-volc",
  "glm-5.0",
  "kimi-k2.5",
];
const DRIVER_MODEL_CACHE_TTL_MS = Number(process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS ?? 60 * 60 * 1000);

type DriverModelCatalog = {
  models: Array<{ id: string; hidden: boolean } & Record<string, unknown>>;
  driver: { id: string; source: string; error?: string; ids: number; cached?: boolean };
};

const driverModelCache = new Map<string, { expiresAt: number; value?: DriverModelCatalog; promise?: Promise<DriverModelCatalog> }>();

function splitModelEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCursorModelList(stdout: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[*\-•]\s*/, "")
      .replace(/^\d+[.)]\s*/, "");
    if (!line) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\s+-\s+.*|\s+\((?:current|default)\)\s*)?$/i);
    const id = match?.[1]?.trim();
    if (!id) continue;
    if (/^(available|models?|model|current|default|name)$/i.test(id)) continue;
    seen.add(id);
  }
  return [...seen];
}

async function loadCursorDriverModels(): Promise<{
  models: Array<{ id: string; hidden: boolean } & Record<string, unknown>>;
  driver: { id: string; source: string; error?: string; ids: number };
}> {
  const envModels = splitModelEnv(process.env.FORGEAX_CURSOR_AGENT_MODELS ?? process.env.CURSOR_AGENT_MODELS);
  let ids = envModels;
  let source = envModels.length > 0 ? "env" : "cli";
  let error: string | undefined;

  if (ids.length === 0) {
    try {
      const binary = await resolveBinary({
        envVarName: "CURSOR_CLI_PATH",
        defaultBinary: "cursor-agent",
      });
      const out = await runCapture(binary, ["--list-models"], { timeoutMs: 5000, captureStderr: true });
      if (out.code === 0) {
        ids = parseCursorModelList(out.stdout);
        if (ids.length === 0) {
          error = "cursor-agent --list-models returned no parseable model ids";
        }
      } else {
        const detail = (out.stderr || out.stdout).trim();
        error = `cursor-agent --list-models exit ${out.code ?? "spawn-failed"}${detail ? `: ${detail}` : ""}`;
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }

  if (ids.length === 0) {
    ids = CURSOR_FALLBACK_MODELS;
    source = "fallback";
  }

  return {
    models: toDriverModelRows(ids, "cursor-agent", CURSOR_DRIVER_LABEL),
    driver: { id: "cursor-agent", source, error, ids: ids.length },
  };
}

function toDriverModelRows(
  ids: string[],
  driverId: string,
  driverLabel: string,
  hidden: Set<string> = new Set(),
): Array<{ id: string; hidden: boolean } & Record<string, unknown>> {
  return ids.map((id) => ({
    id,
    source: "driver",
    driverId,
    driverLabel,
    costMetering: "none",
    input: ["text", "image"],
    reasoning: /thinking|reasoning|opus|sonnet|gpt-5|o\d/i.test(id),
    hidden: hidden.has(id),
  }));
}

function driverIdsFromDisk(
  disk: Record<string, Record<string, unknown>>,
  accept: (id: string) => boolean,
): string[] {
  return Object.keys(disk).filter(accept);
}

function isClaudeCodeModel(id: string): boolean {
  return /^(claude[-_.]|opus$|sonnet$)/i.test(id);
}

function isCodexModel(id: string): boolean {
  return /^(gpt[-_.]|o\d|codex[-_.])|codex/i.test(id);
}

function isa peer agent CLIModel(id: string): boolean {
  return /^(default-model|gemini[-_.]|gpt[-_.]|deepseek[-_.]|glm[-_.]|kimi[-_.])/i.test(id);
}

function withHidden(
  catalog: DriverModelCatalog,
  hidden: Set<string>,
  cached: boolean,
): DriverModelCatalog {
  return {
    models: catalog.models.map((m) => ({ ...m, hidden: hidden.has(String(m.id)) })),
    driver: cached ? { ...catalog.driver, cached: true } : catalog.driver,
  };
}

function driverModelCacheKey(
  providerId: string,
  ctx: { paths: { user(): { modelsFile(): string } } },
): string {
  const env =
    providerId === "cursor-agent"
      ? process.env.FORGEAX_CURSOR_AGENT_MODELS ?? process.env.CURSOR_AGENT_MODELS ?? ""
      : providerId === "claude-code"
        ? process.env.FORGEAX_CLAUDE_CODE_MODELS ?? process.env.CLAUDE_CODE_MODELS ?? ""
        : providerId === "codex"
          ? process.env.FORGEAX_CODEX_MODELS ?? process.env.CODEX_MODELS ?? ""
          : process.env.FORGEAX_CODEBUDDY_MODELS ?? process.env.CODEBUDDY_MODELS ?? "";
  return `${providerId}\0${ctx.paths.user().modelsFile()}\0${env}`;
}

async function loadDriverModelsUncached(
  providerId: string,
  ctx: { paths: { user(): { modelsFile(): string; modelsHiddenFile(): string } } },
): Promise<DriverModelCatalog> {
  if (providerId === "cursor-agent") {
    const res = await loadCursorDriverModels();
    return {
      models: res.models,
      driver: res.driver,
    };
  }

  const disk = loadDiskCatalog(ctx);
  const env =
    providerId === "claude-code"
      ? splitModelEnv(process.env.FORGEAX_CLAUDE_CODE_MODELS ?? process.env.CLAUDE_CODE_MODELS)
      : providerId === "codex"
        ? splitModelEnv(process.env.FORGEAX_CODEX_MODELS ?? process.env.CODEX_MODELS)
        : splitModelEnv(process.env.FORGEAX_CODEBUDDY_MODELS ?? process.env.CODEBUDDY_MODELS);
  const fromDisk = providerId === "claude-code"
    ? driverIdsFromDisk(disk, isClaudeCodeModel)
    : providerId === "codex"
      ? driverIdsFromDisk(disk, isCodexModel)
      : driverIdsFromDisk(disk, isa peer agent CLIModel);
  const fallback = providerId === "claude-code"
    ? CLAUDE_CODE_FALLBACK_MODELS
    : providerId === "codex"
      ? CODEX_FALLBACK_MODELS
      : CODEBUDDY_FALLBACK_MODELS;
  const ids = env.length > 0 ? env : fromDisk.length > 0 ? fromDisk : fallback;
  const source = env.length > 0 ? "env" : fromDisk.length > 0 ? "disk-filter" : "fallback";
  const label = providerId === "claude-code"
    ? CLAUDE_CODE_DRIVER_LABEL
    : providerId === "codex"
      ? CODEX_DRIVER_LABEL
      : CODEBUDDY_DRIVER_LABEL;

  return {
    models: toDriverModelRows(ids, providerId, label),
    driver: { id: providerId, source, ids: ids.length },
  };
}

async function loadDriverModels(
  providerId: string,
  ctx: { paths: { user(): { modelsFile(): string; modelsHiddenFile(): string } } },
): Promise<DriverModelCatalog> {
  const hidden = loadHiddenSet(ctx);
  const ttlMs = Number.isFinite(DRIVER_MODEL_CACHE_TTL_MS) ? DRIVER_MODEL_CACHE_TTL_MS : 60 * 60 * 1000;
  if (ttlMs <= 0) {
    return withHidden(await loadDriverModelsUncached(providerId, ctx), hidden, false);
  }

  const key = driverModelCacheKey(providerId, ctx);
  const now = Date.now();
  const hit = driverModelCache.get(key);
  if (hit?.value && hit.expiresAt > now) {
    return withHidden(hit.value, hidden, true);
  }
  if (hit?.promise) {
    return withHidden(await hit.promise, hidden, true);
  }

  const promise = loadDriverModelsUncached(providerId, ctx);
  driverModelCache.set(key, { expiresAt: now + ttlMs, promise });
  try {
    const value = await promise;
    driverModelCache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return withHidden(value, hidden, false);
  } catch (err) {
    driverModelCache.delete(key);
    throw err;
  }
}

/** Read `~/.forgeax/key/models-hidden.json` —— { hidden: string[] } or [],
 *  treated as the set of ids the user has hidden from the picker dropdown.
 *  Missing file / parse failure → empty set (everything visible by default). */
function loadHiddenSet(ctx: { paths: { user(): { modelsHiddenFile(): string } } }): Set<string> {
  const file = ctx.paths.user().modelsHiddenFile();
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { hidden?: unknown } | string[];
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.hidden) ? raw.hidden : [];
    return new Set(arr.filter((x): x is string => typeof x === "string" && x.length > 0));
  } catch {
    return new Set();
  }
}

function saveHiddenSet(
  ctx: { paths: { user(): { modelsHiddenFile(): string; keyDir(): string } } },
  set: Set<string>,
): void {
  const file = ctx.paths.user().modelsHiddenFile();
  const dir = ctx.paths.user().keyDir();
  // keyDir is created by ensureUserDirDefaults at boot — but be defensive in
  // case set_model_hidden gets called before any user-dir scaffold runs (e.g.
  // a fresh install where the user never opened Settings → Keys yet).
  try {
    if (!existsSync(dir)) {
      // mkdirSync via dynamic require to avoid pulling node:fs/promises into
      // this hot path; safe because keyDir is a fixed user-home subpath.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
  } catch { /* mkdir best-effort */ }
  const payload = { hidden: Array.from(set).sort() };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/** Read `~/.forgeax/key/models.json` —— 每次调都重读盘，user 编辑后无需重启。
 *  与 src/llm/provider.ts:loadModelCatalog 共享语义（同一份文件，不缓存）。
 *  返回 raw map (id → spec) 而不展平，merge 逻辑要 dedupe by id。 */
function loadDiskCatalog(ctx: { paths: { user(): { modelsFile(): string } } }):
  Record<string, Record<string, unknown>>
{
  const file = ctx.paths.user().modelsFile();
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
 *  variants. claude-fable-5 (v5) therefore lands above claude-opus-4-8 (v4.8),
 *  and the whole claude family sits above gemini / gpt / deepseek / rest. */
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

function byStrength(a: { id: string }, b: { id: string }): number {
  const ka = strengthKey(a.id);
  const kb = strengthKey(b.id);
  for (let i = 0; i < 5; i++) {
    const d = (ka[i] as number) - (kb[i] as number);
    if (d) return d;
  }
  return (ka[5] as string).localeCompare(kb[5] as string);
}

/** Merge disk catalog with LiteLLM proxy live `/v1/models`. Live is SSOT for
 *  "which ids actually route" — disk just annotates metadata (contextWindow /
 *  reasoning / input modalities). When live succeeds we **intersect** disk with
 *  live: a disk entry whose id isn't on the proxy is stale (gemini-2.5-flash-lite,
 *  gpt-5.4-mini etc — proxy retired them, but disk still advertised) and clicking
 *  it produced 400s. Live-only ids fall back to LIVE_DEFAULT_SPEC.
 *
 *  Graceful degradation: live `disabled` (no proxy creds) or `error` (network /
 *  HTTP) → emit full disk catalog so the picker isn't empty when offline. */
async function loadModelsCatalog(
  ctx: { paths: { user(): { modelsFile(): string; modelsHiddenFile(): string } } },
  providerId?: string,
): Promise<{
  models: Array<{ id: string; hidden: boolean } & Record<string, unknown>>;
  live: { source: string; error?: string; ids: number };
  driver?: { id: string; source: string; error?: string; ids: number };
  hiddenCount: number;
}>
{
  if (providerId === "cursor-agent" || providerId === "claude-code" || providerId === "codex" || providerId === "codebuddy") {
    const driver = await loadDriverModels(providerId, ctx);
    return {
      models: driver.models,
      live: { source: "skipped", ids: 0 },
      driver: driver.driver,
      hiddenCount: 0,
    };
  }

  const disk = loadDiskCatalog(ctx);
  const live = await fetchLiveCatalog();
  const hidden = loadHiddenSet(ctx);

  const liveAuthoritative = live.source === "live" || live.source === "cache";
  const liveSet = new Set(live.ids);

  const seen = new Set<string>();
  const out: Array<{ id: string; hidden: boolean } & Record<string, unknown>> = [];

  // `live` = "this id is served by the proxy right now", kept ORTHOGONAL to
  // `source` (= where the metadata came from). When live is authoritative every
  // surviving row is proxy-served, so `live` is uniformly true — the UI badge
  // then marks the whole list, instead of only the metadata-less rows (which
  // made the enriched rows look like they weren't live). Offline → all false.
  //
  // Collect the union: when live is authoritative the shown set IS the live set
  // (disk-only ids the proxy retired are dropped — clicking them would 404, and
  // per the "live wins" contract disk is now just a silent metadata annotation).
  // Live-only ids get sane defaults so the picker can still render them.
  for (const [id, spec] of Object.entries(disk)) {
    if (liveAuthoritative && !liveSet.has(id)) continue;
    out.push({ id, source: "disk", ...spec, hidden: hidden.has(id), live: liveAuthoritative });
    seen.add(id);
  }
  for (const id of live.ids) {
    if (seen.has(id)) continue;
    out.push({ id, ...LIVE_DEFAULT_SPEC, hidden: hidden.has(id), live: liveAuthoritative });
    seen.add(id);
  }

  // Strongest-first ordering (see byStrength) — file order is no longer the SSOT
  // for display order; the strength rule is, so live-only models slot in by rank
  // instead of piling up at the end.
  out.sort(byStrength);

  return {
    models: out,
    live: { source: live.source, error: live.error, ids: live.ids.length },
    hiddenCount: hidden.size,
  };
}

const models: CommandModule = {
  async list() {
    return [
      {
        name: "list_models",
        description: "读 ~/.forgeax/key/models.json 全量模型 catalog（无参数 · 实时读盘）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "get_agent_model",
        description: "查 agent.json::models.model（args[0]=sid, args[1]=agentPath · 归一成 chain[] + selected = chain[0]）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "set_agent_models",
        description: "写 agent.json models.model 为模型链（args[0]=sid, args[1]=agentPath, args[2..]=model 名；单模型也写成 [\"MODEL\"]）",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "set_model_hidden",
        description: "把某个模型从 Composer picker dropdown 里隐藏 / 取消隐藏。args[0]=model id, args[1]='1'|'0' (1=hide, 0=show). 写 ~/.forgeax/key/models-hidden.json。",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_models") {
      const providerId = (args[0] ?? "").trim();
      return await loadModelsCatalog(ctx, providerId || undefined);
    }
    if (name !== "get_agent_model") throw new Error(`No query for: ${name}`);

    const { sid, agentPath } = parseAgentArgs(name, args);
    const session = await ctx.sm.open(sid);
    // Pre-scaffold tolerance: when the chat tab pins a marketplace persona
    // (mochi / rin / …) before the session tree contains it, this query
    // races the scaffold pipeline (POST /api/sessions/:sid/messages auto-
    // scaffolds on first send). Returning a graceful empty state lets the
    // composer keep rendering — the picker simply shows "no model selected
    // yet" until the agent is real, instead of spamming a 500 every poll.
    const agentJsonFile = ctx.paths.session(sid).agent(agentPath).agentJson();
    if (!session.tree.get(agentPath) || !existsSync(agentJsonFile)) {
      return { sid, agentPath, selected: null, chain: [], raw: null, pending: true };
    }

    const raw = readAgentJsonRaw(agentJsonFile, name);
    const modelsField = raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)
      ? (raw.models as Record<string, unknown>)
      : null;
    const rawValue = modelsField ? modelsField.model ?? null : null;
    const { chain, selected } = normalizeModel(rawValue);

    return {
      sid,
      agentPath,
      selected,         // chain[0] ?? null —— UI 只想拿"当前用哪个"读这个
      chain,            // 完整 fallback 链，永远 string[]（即使盘上是 string 也展开）
      raw: rawValue,    // 原 agent.json 里的字段值（string / string[] / null），不会丢失"用户写了啥"
    };
  },

  async execute(name, args, ctx) {
    if (name === "set_model_hidden") {
      const id = (args[0] ?? "").trim();
      const flag = (args[1] ?? "").trim();
      if (!id) throw new Error(`${name}: args[0] (model id) required`);
      if (flag !== "0" && flag !== "1") {
        throw new Error(`${name}: args[1] must be '1' (hide) or '0' (show), got '${flag}'`);
      }
      const set = loadHiddenSet(ctx);
      const wasHidden = set.has(id);
      if (flag === "1") set.add(id); else set.delete(id);
      saveHiddenSet(ctx, set);
      return {
        id,
        hidden: flag === "1",
        previouslyHidden: wasHidden,
        totalHidden: set.size,
        file: ctx.paths.user().modelsHiddenFile(),
      };
    }
    if (name !== "set_agent_models") throw new Error(`No execute for: ${name}`);

    const { sid, agentPath } = parseAgentArgs(name, args);
    const chain = args.slice(2).map((m) => m.trim()).filter(Boolean);
    if (chain.length === 0) {
      throw new Error(`${name}: at least one model name required (args[2..])`);
    }

    const session = await ctx.sm.open(sid);
    // Don't gate the write on in-memory tree membership: the FSWatcher that
    // feeds session.tree lags a freshly-scaffolded / just-opened session by a
    // tick, so an otherwise-valid write would spuriously fail with "agent path
    // not found in tree" (surfaced as an empty {} in the picker). The real
    // precondition is that agent.json exists (readAgentJsonRaw throws a clear
    // error if not); the restart below is already guarded by scheduler.getAgent,
    // so a not-yet-scheduled agent simply skips restart and picks up the new
    // model when it starts. This mirrors get_agent_model's pre-scaffold tolerance.
    const agentJsonFile = ctx.paths.session(sid).agent(agentPath).agentJson();
    const raw = readAgentJsonRaw(agentJsonFile, name);

    const prevModels =
      raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)
        ? (raw.models as Record<string, unknown>)
        : {};
    raw.models = { ...prevModels, model: chain };

    writeFileSync(agentJsonFile, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    let restarted = false;
    if (session.scheduler.getAgent(agentPath)) {
      await session.scheduler.controlAgent("restart", agentPath);
      restarted = true;
    }

    return {
      sid,
      agentPath,
      models: { model: chain },
      selected: chain[0],
      restarted,
      agentJsonFile,
    };
  },
};

export default models;
