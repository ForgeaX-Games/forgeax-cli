/** BaseKitLoader<TFactory, TInstance> — stateless kit loading core.
 *
 *  Subclasses implement `createInstance(factory, ctx, name)` and a public
 *  `load(ctx)` that calls `loadOnce(ctx)` (single-runner with mid-flight
 *  dirty re-trigger; see agenteam-os-ref/src/loaders/base-loader.ts §
 *  `_inflight / _dirty`).
 *
 *  4-layer source build (forgeax; ref is 3-layer instance/team/agent):
 *    **builtin → user → session → agent**   (last wins for **whole-kit**
 *    override; per-file Frankenstein merging is forbidden — ownership stays
 *    clean: `lib/` import paths, `condition.ts` provenance never split.)
 *
 *  Storage key uses qualified `kit/kind/name`. Reverse `entry → deps` graph
 *  drives precise reload via `kits/resolve-hook.ts`.
 *
 *  Per-kit `condition.ts` exports (resolved once per `_loadInternal` pass,
 *  embedded into each entry's wrapper closure — no shared mutable state):
 *    - `default` / `condition`: KitConditionFn → wraps entry.condition (AND).
 *    - `configDefaults`        : `Record<configKey, Record<key, unknown>>`
 *                                 merged into `kits.config[<kit>]` first-load.
 *    - `agentDefaults`         : `Record<key, unknown>` shallow-merged into
 *                                 agent.json root first-load (skip existing).
 *
 *  历史版本将 default-merge 结果写到 `agent-overrides.json`（让 agent.json 保持
 *  user/template-owned）。本轮（2026-05-20）`agent-overrides.json` 概念彻底废
 *  弃 —— configDefaults / agentDefaults 直接 patch 进 `agent.json`，已存在的字
 *  段不覆盖。简化模型：单一文件 SSOT，少一处脏盘 + reload 路径。 */

import { isAbsolute, join, resolve } from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { AgentContext } from "../core/types";
import type { PathManagerAPI } from "../fs/types";
import { getPathManager } from "../fs/path-manager";
import { withModelFeedback, runWithAgentScope } from "../core/logger";
import { deepMerge } from "../utils/deep-merge";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import type {
  KitDescriptor,
  KitKind,
  KitSource,
  KitsConfig,
  CapabilityBase,
} from "./types";
import {
  computeFileHash,
  invalidateHash,
  shortHash,
  beginTrackEntry,
  endTrackEntry,
  getEntryDeps,
  ensureResolveHookRegistered,
} from "./resolve-hook";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Qualified key builder — exported so registries / loaders agree on naming. */
export function qualifiedName(d: KitDescriptor): string {
  return `${d.pkg}/${d.kind}/${d.name}`;
}

/** Discover kits with **whole-kit** override semantics:
 *  1. For each kit name, determine its winning source layer (builtin → user
 *     → session → agent — last wins). A kit "exists" at a layer iff its
 *     directory is present; kind content is irrelevant to winner choice.
 *  2. Scan the winning layer's `{kit}/{kind}/` only. Lower layers are fully
 *     hidden — no per-file merging.
 *
 *  Returns `KitDescriptor[]` ordered by encounter; caller can stable-sort if
 *  needed (most callers don't care). */
export async function discoverKitPackages(
  sources: KitSource[],
  kind: KitKind,
): Promise<KitDescriptor[]> {
  // Step 1: winning source per kit name. Iterate sources in order; later wins.
  const winner = new Map<string, KitSource>();
  for (const source of sources) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(source.dir, { withFileTypes: true });
    } catch {
      continue;                                     // source dir doesn't exist
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      winner.set(e.name, source);
    }
  }

  // Step 2: scan winning layer's {kind}/ only.
  const out: KitDescriptor[] = [];
  for (const [pkg, source] of winner) {
    const kindDir = join(source.dir, pkg, kind);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(kindDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".ts")) continue;
      if (e.name.startsWith(".")) continue;
      out.push({
        name: e.name.slice(0, -3),
        pkg,
        kind,
        path: join(kindDir, e.name),
        layer: source.id,
      });
    }
  }
  return out;
}

// ─── Per-kit condition.ts ────────────────────────────────────────────────────

export type KitConditionFn = (ctx: AgentContext) => boolean;

/** Load `<kit>/condition.ts`; safe to call when the file does not exist. */
export async function importKitCondition(
  conditionPath: string,
): Promise<{
  fn: KitConditionFn | null;
  configDefaults: Record<string, Record<string, unknown>> | null;
  agentDefaults: Record<string, unknown> | null;
}> {
  try {
    invalidateHash(conditionPath);
    const hash = computeFileHash(conditionPath);
    if (hash === "0") {
      return { fn: null, configDefaults: null, agentDefaults: null };
    }
    const mod: any = await import(`${conditionPath}?v=${hash}`);
    const fn = mod.default ?? mod.condition;
    const cd = mod.configDefaults;
    const ad = mod.agentDefaults;
    return {
      fn: typeof fn === "function" ? fn : null,
      configDefaults:
        cd && typeof cd === "object"
          ? (cd as Record<string, Record<string, unknown>>)
          : null,
      agentDefaults:
        ad && typeof ad === "object"
          ? (ad as Record<string, unknown>)
          : null,
    };
  } catch {
    return { fn: null, configDefaults: null, agentDefaults: null };
  }
}

function wrapWithKitCondition<T extends CapabilityBase>(
  original: T["condition"],
  pkg: string,
  pkgCondFn: KitConditionFn | null,
): NonNullable<T["condition"]> {
  if (!pkgCondFn) return (original ?? (() => true)) as NonNullable<T["condition"]>;
  return ((ctx, self) => {
    try {
      if (!pkgCondFn(ctx)) return false;
    } catch (err: any) {
      withModelFeedback(() =>
        console.warn(`[kits] condition.ts error in kit "${pkg}": ${err?.message ?? err}`),
      );
      return false;                                 // fail-closed
    }
    return !original || original(ctx, self);
  }) as NonNullable<T["condition"]>;
}

function wrapWithVisibilityCondition<T extends CapabilityBase>(
  original: T["condition"],
  descriptor: KitDescriptor,
): NonNullable<T["condition"]> {
  return ((ctx, self) => {
    const config = (ctx.getAgentJson().kits ?? AGENT_DEFAULTS.kits) as KitsConfig;
    if (!BaseKitLoader.isVisibleByConfig(descriptor, config)) return false;
    return !original || original(ctx, self);
  }) as NonNullable<T["condition"]>;
}

function matchesToken(d: KitDescriptor, token: string): boolean {
  if (token.startsWith("#")) return d.pkg === token.slice(1);
  if (token.includes("/")) {
    const parts = token.split("/");
    if (parts.length < 3) return false;
    const pkg = parts[0];
    const target = parts[parts.length - 1];
    if (target === "*") return d.pkg === pkg;
    return d.pkg === pkg && d.name === target;
  }
  return d.name === token;
}

// ─── BaseKitLoader ───────────────────────────────────────────────────────────

export abstract class BaseKitLoader<TFactory, TInstance> {

  /** Build the 4-layer source list for a (sid, agentPath). `redirected` opt
   *  comes from `agent.json.kitRedirect` —— absolute or relative-to-agentDir. */
  static buildSources(
    pm: PathManagerAPI,
    sid: string,
    agentPath: string,
    redirected?: string,
  ): KitSource[] {
    const agentLayer = pm.session(sid).agent(agentPath);
    const localDir = redirected
      ? (isAbsolute(redirected) ? redirected : resolve(agentLayer.root(), redirected))
      : agentLayer.resourceDir("kits");
    return [
      { id: "builtin", dir: pm.builtin().resourceDir("kits") },
      { id: "user",    dir: pm.user().resourceDir("kits") },
      { id: "session", dir: pm.session(sid).resourceDir("kits") },
      { id: "agent",   dir: localDir },
    ];
  }

  // ─── Minimal state ────────────────────────────────────────────────────────

  protected logAgentId = "system";
  protected _hasLoadedOnce = false;
  /** ESM module ref → wrapped instance. Same ref = file unchanged → reuse. */
  protected _moduleCache = new WeakMap<object, TInstance>();

  /** Single-runner; mid-flight dirty re-trigger. */
  private _inflight: Promise<Map<string, TInstance>> | null = null;
  private _dirty = false;

  protected abstract readonly kind: KitKind;

  /** Subclass-specific instance construction from imported module. */
  abstract createInstance(factory: TFactory, ctx: AgentContext, name: string): TInstance | null;

  setLogContext(agentId = "system"): void {
    this.logAgentId = agentId;
  }

  /** Default `importFactory` —— dep-tracked content-hash cache-bust via
   *  resolve-hook. Subclasses can override but rarely should. */
  async importFactory(path: string): Promise<TFactory> {
    ensureResolveHookRegistered();
    invalidateHash(path);
    const entryHash = computeFileHash(path);

    // Combined hash includes recorded deps from previous loads (none on first
    // load → entryHash only; V8 cache empty so no bust needed).
    const deps = getEntryDeps(path);
    let combined = entryHash;
    if (deps.size > 0) {
      const depHashes = [...deps]
        .sort()
        .map((d) => { invalidateHash(d); return computeFileHash(d); });
      combined = shortHash(entryHash + depHashes.join(""));
    }

    // condition.ts is loaded separately (not in import graph). Include its
    // hash so the entry wrapper rebuilds when condition.ts changes —
    // condition.ts must stay standalone (no local imports), enforced socially.
    const condPath = join(path, "..", "..", "condition.ts");
    invalidateHash(condPath);
    const condHash = computeFileHash(condPath);
    if (condHash !== "0") combined = shortHash(combined + condHash);

    beginTrackEntry(path);
    try {
      return (await import(`${path}?v=${combined}`)) as TFactory;
    } finally {
      endTrackEntry();
    }
  }

  /** Subclass `load(ctx)` calls this instead of `_loadInternal` directly. */
  protected async loadOnce(ctx: AgentContext): Promise<Map<string, TInstance>> {
    if (this._inflight) { this._dirty = true; return this._inflight; }
    const run = (async () => {
      try {
        let result: Map<string, TInstance>;
        do {
          this._dirty = false;
          result = await this._loadInternal(ctx);
        } while (this._dirty);
        return result;
      } finally {
        this._inflight = null;
      }
    })();
    this._inflight = run;
    return run;
  }

  /** Main load body —— scan 4 layers, import factories, wrap conditions,
   *  return `qualifiedName → instance` map. Failure to load any single
   *  entry doesn't poison the rest (logged via `withModelFeedback`). */
  protected async _loadInternal(ctx: AgentContext): Promise<Map<string, TInstance>> {
    const sid = sessionIdFromCtx(ctx);
    const redirect = (ctx.getAgentJson().kitRedirect ?? "").trim() || undefined;
    const sources = BaseKitLoader.buildSources(getPathManager(), sid, ctx.agentPath, redirect);
    const descriptors = await discoverKitPackages(sources, this.kind);

    const registry = new Map<string, TInstance>();
    const collectedConfigDefaults: { pkg: string; defaults: Record<string, Record<string, unknown>> }[] = [];
    const collectedAgentDefaults: Record<string, unknown>[] = [];

    // Load per-kit conditions once. Reusing pkgCondFns across entries of the
    // same pkg avoids re-importing the same condition.ts N times in one pass.
    const pkgCondFns = new Map<string, KitConditionFn | null>();
    for (const d of descriptors) {
      if (pkgCondFns.has(d.pkg)) continue;
      const source = sources.find((s) => s.id === d.layer);
      if (!source) { pkgCondFns.set(d.pkg, null); continue; }
      const condPath = join(source.dir, d.pkg, "condition.ts");
      const { fn, configDefaults, agentDefaults } = await importKitCondition(condPath);
      pkgCondFns.set(d.pkg, fn);
      if (configDefaults) collectedConfigDefaults.push({ pkg: d.pkg, defaults: configDefaults });
      if (agentDefaults) collectedAgentDefaults.push(agentDefaults);
    }

    for (const d of descriptors) {
      const qName = qualifiedName(d);
      try {
        await runWithAgentScope(this.logAgentId, async () => {
          const factory = await this.importFactory(d.path);

          // Reuse cached wrapped instance if the underlying module ref is
          // unchanged. Same content + same combined-hash → same ESM module
          // ref → WeakMap hit.
          const cached = this._moduleCache.get(factory as object);
          if (cached !== undefined) { registry.set(qName, cached); return; }

          const instance = this.createInstance(factory, ctx, qName);
          if (instance === null) return;

          // Embed visibility (per-turn config check) + kit condition (per-kit
          // condition.ts) into each instance's `condition` closure. Both
          // wrappers fail-closed if the underlying predicate throws.
          const inst = instance as unknown as CapabilityBase;
          if (inst && typeof inst === "object") {
            inst.condition = wrapWithVisibilityCondition(inst.condition, d);
            inst.condition = wrapWithKitCondition(inst.condition, d.pkg, pkgCondFns.get(d.pkg) ?? null);
          }

          this._moduleCache.set(factory as object, instance);
          registry.set(qName, instance);
        });
      } catch (err: any) {
        process.stderr.write(`[BaseKitLoader] failed to load "${qName}": ${err?.message ?? err}\n`);
      }
    }

    if (!this._hasLoadedOnce) {
      await this.mergeDefaults(ctx, collectedConfigDefaults, collectedAgentDefaults);
      this._hasLoadedOnce = true;
    }
    return registry;
  }

  /** Visibility predicate driven by `KitsConfig` (enable/disable tokens +
   *  user/session layer switches). Pure helper — exposed so subclasses can
   *  re-evaluate per-turn without a full reload. builtin / agent layers
   *  always default-visible; user / session opt-in via `kits.user/session`. */
  static isVisibleByConfig(d: KitDescriptor, config: KitsConfig): boolean {
    let selected: boolean;
    if (d.layer === "builtin" || d.layer === "agent") {
      selected = true;
    } else if (d.layer === "user") {
      selected = (config.user ?? "none") === "all";
    } else {
      selected = (config.session ?? "none") === "all";
    }
    for (const token of config.enable ?? []) {
      if (matchesToken(d, token)) { selected = true; break; }
    }
    for (const token of config.disable ?? []) {
      if (matchesToken(d, token)) { selected = false; break; }
    }
    return selected;
  }

  /** First-load merge of per-kit `configDefaults` + `agentDefaults` directly
   *  into `agent.json`. Existing keys never get overwritten; only **new**
   *  default keys are added. 写盘前再读一次 agent.json，避免和外部并发写覆盖
   *  其它字段。 */
  private async mergeDefaults(
    ctx: AgentContext,
    configDefaults: { pkg: string; defaults: Record<string, Record<string, unknown>> }[],
    agentDefaultsList: Record<string, unknown>[],
  ): Promise<void> {
    if (configDefaults.length === 0 && agentDefaultsList.length === 0) return;
    const agentJson = ctx.getAgentJson() as unknown as Record<string, unknown>;
    const newKeys: Record<string, unknown> = {};
    let dirty = false;

    // 1) kit-level configDefaults → kits.config[<pkg>][<key>] = defaults
    if (configDefaults.length > 0) {
      const kits = (agentJson.kits ?? {}) as Record<string, unknown>;
      const currentConfig = (kits.config ?? {}) as Record<string, Record<string, unknown>>;
      const newConfig: Record<string, Record<string, unknown>> = {};

      for (const { pkg, defaults } of configDefaults) {
        for (const [key, defs] of Object.entries(defaults)) {
          if (currentConfig[pkg]?.[key] !== undefined) continue;
          newConfig[pkg] ??= {};
          newConfig[pkg][key] = defs;
          dirty = true;
        }
      }

      if (Object.keys(newConfig).length > 0) {
        newKeys.kits = { config: newConfig };
      }
    }

    // 2) agentDefaults → agent.json root, shallow, skip already-set.
    for (const defaults of agentDefaultsList) {
      for (const [key, value] of Object.entries(defaults)) {
        if (key in agentJson) continue;
        newKeys[key] = value;
        dirty = true;
      }
    }

    if (!dirty) return;

    const sid = sessionIdFromCtx(ctx);
    const agentJsonPath = getPathManager().session(sid).agent(ctx.agentPath).agentJson();
    let onDisk: Record<string, unknown> = {};
    try { onDisk = JSON.parse(await readFile(agentJsonPath, "utf-8")); } catch { /* missing → 用 in-memory 兜底 */ }
    const merged = deepMerge(onDisk, newKeys);
    await writeFile(agentJsonPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pull sid out of agentDir —— AgentContext doesn't carry sid directly to
 *  avoid plumbing it through every kit. `<userRoot>/sessions/<sid>/...` ->
 *  splits on `/sessions/` and takes the next segment. */
function sessionIdFromCtx(ctx: AgentContext): string {
  const m = ctx.agentDir.match(/\/sessions\/([^/]+)\//);
  if (!m) throw new Error(`[BaseKitLoader] cannot extract sid from agentDir '${ctx.agentDir}'`);
  return m[1];
}

export const __kits_internal__ = { qualifiedName, matchesToken };
