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
): Promise<{
  models: Array<{ id: string; hidden: boolean } & Record<string, unknown>>;
  live: { source: string; error?: string; ids: number };
  hiddenCount: number;
}>
{
  const disk = loadDiskCatalog(ctx);
  const live = await fetchLiveCatalog();
  const hidden = loadHiddenSet(ctx);

  const liveAuthoritative = live.source === "live" || live.source === "cache";
  const liveSet = new Set(live.ids);

  const seen = new Set<string>();
  const out: Array<{ id: string; hidden: boolean } & Record<string, unknown>> = [];

  // Disk entries first — keeps user's manually-tuned models at the top of UI lists.
  // When live is authoritative, drop disk ids the proxy doesn't serve.
  for (const [id, spec] of Object.entries(disk)) {
    if (liveAuthoritative && !liveSet.has(id)) continue;
    out.push({ id, source: "disk", ...spec, hidden: hidden.has(id) });
    seen.add(id);
  }
  // Live-only entries get sane defaults so picker can render them.
  for (const id of live.ids) {
    if (seen.has(id)) continue;
    out.push({ id, ...LIVE_DEFAULT_SPEC, hidden: hidden.has(id) });
    seen.add(id);
  }

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
      return await loadModelsCatalog(ctx);
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
    if (!session.tree.get(agentPath)) {
      throw new Error(`${name}: agent path not found in tree: ${agentPath}`);
    }

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
