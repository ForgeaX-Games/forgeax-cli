/**
 * BaseLoader<TFactory, TInstance> — stateless capability loading skeleton.
 *
 * Subclasses implement: importFactory / validateFactory / createInstance
 *
 * load() scans the three-layer capability directories (instance → team → agent),
 * imports .ts files, validates factories, creates instances, and returns them.
 * The caller (BaseAgent) owns the registry and FSWatcher integration.
 *
 * Registry key uses qualified name package/kind/name (e.g. "workspace_read/tools/read_file").
 */

import { relative, isAbsolute, join, resolve } from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { withModelFeedback } from "../core/logger.js";
import type {
  CapabilityDescriptor,
  CapabilitiesConfig,
  CapabilitySource,
  AgentContext,
  PathManagerAPI,
} from "../core/types.js";
import { runWithAgentScope } from "../core/logger.js";
import { getPathManager } from "../fs/path-manager.js";
import { deepMerge } from "../core/deep-merge.js";
import { AGENT_DEFAULTS } from "../defaults/agent/agent-json.js";
import { computeFileHash, invalidateHash, shortHash, beginTrackEntry, endTrackEntry, getEntryDeps } from "./capability-resolve-hook.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function qualifiedName(d: CapabilityDescriptor): string {
  return d.pkg && d.kind ? `${d.pkg}/${d.kind}/${d.name}` : d.name;
}

/**
 * Discover capabilities with **package-level** override semantics:
 *   1. For each package name, determine its winning source layer
 *      (agent-local > team > instance). A package "exists" at a layer iff its
 *      directory is present there — kind content is irrelevant to winner selection.
 *   2. Scan the winning layer's `{pkg}/{kind}/` directory only. Lower layers
 *      are fully hidden — no per-file Frankenstein merging.
 *
 * Rationale: a package is a cohesive unit (tools + slots + plugins + `lib/` +
 * `condition.ts` + `configDefaults`). Overriding one file while inheriting
 * siblings from a lower layer produces subtle bugs (e.g. `lib/` import paths,
 * indeterminate condition.ts origin). Whole-package replacement keeps the
 * ownership model unambiguous.
 */
async function discoverCapabilityPackages(
  sources: CapabilitySource[],
  kind: "tools" | "slots" | "plugins",
): Promise<CapabilityDescriptor[]> {
  // Step 1: determine the winning source for each package name.
  // Iterate sources in order (instance → team → agent); later overwrites earlier.
  const winningSource = new Map<string, CapabilitySource>();
  for (const source of sources) {
    try {
      const pkgs = await readdir(source.dir, { withFileTypes: true });
      for (const pkgEntry of pkgs) {
        if (!pkgEntry.isDirectory()) continue;
        winningSource.set(pkgEntry.name, source);
      }
    } catch { /* source dir doesn't exist */ }
  }

  // Step 2: scan only the winning layer's `{kind}/` for each package.
  const descriptors: CapabilityDescriptor[] = [];
  for (const [pkg, source] of winningSource) {
    const kindDir = join(source.dir, pkg, kind);
    try {
      const entries = await readdir(kindDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const name = entry.name.slice(0, -3);
        descriptors.push({
          name,
          pkg,
          kind,
          path: join(kindDir, entry.name),
          layer: source.id,
        });
      }
    } catch { /* kind dir doesn't exist in winning layer */ }
  }
  return descriptors;
}

// ─── Package Condition ──────────────────────────────────────────────────────

export type PackageConditionFn = (ctx: AgentContext) => boolean;

// Package-level condition fns are resolved once per _loadInternal pass and
// embedded directly into each entry's wrapper closure. When condition.ts
// changes, importFactory includes its hash in the cache key → fresh factory
// import → new wrapper built with updated fn.
//
// No shared mutable state: each agent's loader owns its own resolved fns,
// preventing cross-agent conflict when multiple agents have agent-local
// packages with the same name.

export async function importPackageCondition(
  conditionPath: string,
): Promise<{
  fn: PackageConditionFn | null;
  configDefaults: Record<string, Record<string, unknown>> | null;
  agentDefaults: Record<string, unknown> | null;
}> {
  try {
    const hash = computeFileHash(conditionPath);
    const mod = await import(`${conditionPath}?v=${hash}`);
    const fn = mod.default ?? mod.condition;
    const configDefaults = mod.configDefaults;
    const agentDefaults = mod.agentDefaults;
    return {
      fn: typeof fn === "function" ? fn : null,
      configDefaults: configDefaults && typeof configDefaults === "object" ? configDefaults as Record<string, Record<string, unknown>> : null,
      agentDefaults: agentDefaults && typeof agentDefaults === "object" ? agentDefaults as Record<string, unknown> : null,
    };
  } catch {
    return { fn: null, configDefaults: null, agentDefaults: null };
  }
}

function wrapWithPackageCondition(
  original: ((ctx: AgentContext, self?: any) => boolean) | undefined,
  pkgName: string,
  pkgCondFn: PackageConditionFn | null,
): (ctx: AgentContext, self?: any) => boolean {
  if (!pkgCondFn) return original ?? (() => true);
  return (ctx, self) => {
    try {
      if (!pkgCondFn(ctx)) return false;
    } catch (err: any) {
      withModelFeedback(() =>
        console.warn(`condition.ts error in package "${pkgName}": ${err?.message ?? err}`));
      return false; // fail-closed
    }
    return !original || original(ctx, self);
  };
}

// ─── Visibility Condition ────────────────────────────────────────────────────

/** Check whether a descriptor is visible given a CapabilitiesConfig (evaluated per-turn). */
function isVisibleByConfig(
  d: CapabilityDescriptor,
  config: CapabilitiesConfig,
): boolean {
  let selected: boolean;
  if (d.layer !== "instance" && d.layer !== "team") {
    selected = true;
  } else if (d.layer === "team") {
    selected = (config.team ?? "none") === "all";
  } else {
    selected = (config.global ?? "none") === "all";
  }

  for (const token of config.enable ?? []) {
    if (matchesToken(d, token)) { selected = true; break; }
  }
  for (const token of config.disable ?? []) {
    if (matchesToken(d, token)) { selected = false; break; }
  }

  return selected;
}

function matchesToken(d: CapabilityDescriptor, token: string): boolean {
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

function wrapWithVisibilityCondition(
  original: ((ctx: AgentContext, self?: any) => boolean) | undefined,
  descriptor: CapabilityDescriptor,
): (ctx: AgentContext, self?: any) => boolean {
  return (ctx, self) => {
    const config = ctx.getAgentJson().capabilities ?? AGENT_DEFAULTS.capabilities;
    if (!isVisibleByConfig(descriptor, config)) return false;
    return !original || original(ctx, self);
  };
}

// ─── BaseLoader ─────────────────────────────────────────────────────────────

export abstract class BaseLoader<TFactory, TInstance> {
  static buildSources(
    pm: PathManagerAPI,
    agentId: string,
    redirected?: string,
  ): CapabilitySource[] {
    const localDir = redirected
      ? (isAbsolute(redirected) ? redirected : resolve(pm.agent(agentId).root(), redirected))
      : pm.agent(agentId).capabilitiesDir();
    return [
      { id: "instance", dir: pm.instance().capabilitiesDir() },
      { id: "team", dir: pm.team().capabilitiesDir() },
      { id: agentId, dir: localDir },
    ];
  }

  // ─── Minimal state ───

  protected logAgentId = "system";
  private _hasLoadedOnce = false;
  /** ESM module → wrapped instance. Same module ref = file unchanged → reuse instance. */
  private _moduleCache = new WeakMap<object, TInstance>();

  // Single-runner: at most one _loadInternal in flight; concurrent callers
  // join the same promise. Mid-flight requests set _dirty=true to trigger
  // one extra pass after the current one — ensures the latest disk state
  // wins and eliminates the "stale empty Map clobbers registry" race.
  private _inflight: Promise<Map<string, TInstance>> | null = null;
  private _dirty = false;

  protected abstract readonly kind: "tools" | "slots" | "plugins";

  // ─── Abstract (subclass must implement) ───

  /** Override to customize module import. Default: dynamic import(). */
  async importFactory(path: string): Promise<TFactory> {
    invalidateHash(path);
    const entryHash = computeFileHash(path);

    // Use previously recorded deps (if any) for cache-bust key.
    // First load: no deps recorded → entryHash only (V8 cache empty, no bust needed).
    const deps = getEntryDeps(path);
    let combined = entryHash;
    if (deps.size > 0) {
      const depHashes = [...deps].sort().map(d => { invalidateHash(d); return computeFileHash(d); });
      combined = shortHash(entryHash + depHashes.join(""));
    }

    // condition.ts affects the entry wrapper but is loaded separately;
    // include its hash so wrapper rebuilds when condition changes.
    // condition.ts must remain standalone (no local imports).
    const condPath = join(path, "../../condition.ts");
    invalidateHash(condPath);
    const condHash = computeFileHash(condPath);
    if (condHash !== "0") combined = shortHash(combined + condHash);

    beginTrackEntry(path);
    try {
      return await import(`${path}?v=${combined}`);
    } finally {
      endTrackEntry();
    }
  }

  abstract createInstance(factory: TFactory, ctx: AgentContext, name: string): TInstance | null;

  // ─── Load orchestration ───

  setLogContext(agentId = "system"): void {
    this.logAgentId = agentId;
  }

  /** Subclasses' load() must call this instead of _loadInternal directly. */
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

  protected async _loadInternal(ctx: AgentContext): Promise<Map<string, TInstance>> {
    const sources = BaseLoader.buildSources(getPathManager(), ctx.agentId);
    const descriptors = await discoverCapabilityPackages(sources, this.kind);

    const registry = new Map<string, TInstance>();
    const collectedDefaults: { pkg: string; defaults: Record<string, Record<string, unknown>> }[] = [];
    const collectedAgentDefaults: Record<string, unknown>[] = [];

    // Import package-level conditions + configDefaults + agentDefaults (once per pkg).
    // Condition fns are stored in a per-load local map and embedded directly into
    // each entry's wrapper closure — no shared mutable state across agents.
    const pkgCondFns = new Map<string, PackageConditionFn | null>();
    for (const d of descriptors) {
      if (d.pkg && !pkgCondFns.has(d.pkg)) {
        const source = sources.find(s => s.id === d.layer);
        if (source) {
          const condPath = join(source.dir, d.pkg, "condition.ts");
          const { fn, configDefaults, agentDefaults } = await importPackageCondition(condPath);
          pkgCondFns.set(d.pkg, fn);
          if (configDefaults) {
            collectedDefaults.push({ pkg: d.pkg, defaults: configDefaults });
          }
          if (agentDefaults) {
            collectedAgentDefaults.push(agentDefaults);
          }
        } else {
          pkgCondFns.set(d.pkg, null);
        }
      }
    }

    for (const descriptor of descriptors) {
      const qName = qualifiedName(descriptor);
      try {
        await runWithAgentScope(this.logAgentId, async () => {
          const factory = await this.importFactory(descriptor.path);

          // ESM content-hash: unchanged file → same module ref → reuse instance
          const cached = this._moduleCache.get(factory as object);
          if (cached !== undefined) { registry.set(qName, cached); return; }

          const instance = this.createInstance(factory, ctx, qName);
          if (instance === null) return;

          // Wrap conditions — visibility is dynamic (config-driven per turn);
          // package condition fn is embedded at load time (importFactory
          // includes condition.ts hash in cache key).
          (instance as any).condition = wrapWithVisibilityCondition(
            (instance as any).condition, descriptor,
          );
          if (descriptor.pkg) {
            (instance as any).condition = wrapWithPackageCondition(
              (instance as any).condition,
              descriptor.pkg,
              pkgCondFns.get(descriptor.pkg) ?? null,
            );
          }

          this._moduleCache.set(factory as object, instance);
          registry.set(qName, instance);
        });
      } catch (err) {
        console.log(`[BaseLoader] failed to load "${qName}": ${(err as Error)?.message ?? err}`);
      }
    }

    if (!this._hasLoadedOnce) {
      await this.mergeDefaults(ctx, collectedDefaults, collectedAgentDefaults);
      this._hasLoadedOnce = true;
    }
    return registry;
  }

  /**
   * Merge configDefaults from condition.ts into agent-overrides.json (persisted).
   * Only writes if new keys are added — existing values (in either base or overrides) are preserved.
   * New defaults go into agent-overrides.json so that agent.json stays pack-owned.
   */
  private async mergeDefaults(
    ctx: AgentContext,
    collected: { pkg: string; defaults: Record<string, Record<string, unknown>> }[],
    agentDefaultsList: Record<string, unknown>[],
  ): Promise<void> {
    if (collected.length === 0 && agentDefaultsList.length === 0) return;
    const agentJson = ctx.getAgentJson() as Record<string, unknown>;
    const newKeys: Record<string, unknown> = {};
    let dirty = false;

    // 1. Package-level configDefaults → capabilities.config[pkg][key]
    if (collected.length > 0) {
      const caps = (agentJson.capabilities ?? {}) as Record<string, unknown>;
      const currentConfig = (caps.config ?? {}) as Record<string, Record<string, unknown>>;
      const newConfig: Record<string, Record<string, unknown>> = {};

      for (const { pkg, defaults } of collected) {
        for (const [key, capDefaults] of Object.entries(defaults)) {
          if (currentConfig[pkg]?.[key] !== undefined) continue;
          newConfig[pkg] ??= {};
          newConfig[pkg][key] = capDefaults;
          dirty = true;
        }
      }

      if (Object.keys(newConfig).length > 0) {
        newKeys.capabilities = { config: newConfig };
      }
    }

    // 2. agentDefaults → root level (shallow merge, skip existing)
    for (const defaults of agentDefaultsList) {
      for (const [key, value] of Object.entries(defaults)) {
        if (key in agentJson) continue;
        newKeys[key] = value;
        dirty = true;
      }
    }

    if (dirty) {
      const overridesPath = getPathManager().agent(ctx.agentId).configOverrides();
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(await readFile(overridesPath, "utf-8")); } catch {}
      const merged = deepMerge(existing, newKeys);
      await writeFile(overridesPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    }
  }

}
