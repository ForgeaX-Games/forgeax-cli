// @desc Scheduler-level coordinator for agent-scope hot-reload (capabilities + ScriptAgent src/).
/**
 * AgentReloadCoordinator — central hot-reload dispatcher for two agent-scope
 * concerns that share the same triggering infrastructure (fs.watch + per-batch
 * hash polling):
 *
 *   1. Capability hot-reload (tools / slots / plugins under capabilities/)
 *      — reactive fs.watch fires on capability dirs; reload delegates to the
 *        existing _loadInternal → discoverCapabilityPackages → replaceStatic
 *        pipeline (priority resolution + diffing).
 *      — Shared dirs (instance/capabilities, team/capabilities) use ONE watcher
 *        each, replacing per-agent registrations.
 *
 *   2. ScriptAgent src/index.ts hot-reload (and hot-create / type transformation
 *      / post-shutdown revival)
 *      — Polling-only (flushReloads, called after each ConsciousAgent tool
 *        batch) via scanScriptSrc(). fs.watch recursive mode silently misses
 *        `open(O_TRUNC)+write+close` events on Linux ext4, which is the
 *        dominant write pattern of admin tools (fs/promises.writeFile).
 *        polling is the SOLE trigger surface — the previous reactive
 *        Scheduler.watchAgentSrcDirs has been removed (v5+); any change
 *        Scheduler needs to react to flows through the injected
 *        scriptSrcChanged callback.
 *
 * File changes are verified via content hash before triggering reload, so
 * spurious fs events (touch, atime updates) don't fire false reloads.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FSWatcherAPI, WatchRegistration, PathManagerAPI } from "../core/types.js";
import type { BaseAgent } from "../core/base-agent.js";
import { SCRIPT_ENTRY_SEGMENTS } from "../core/script-agent.js";
import { computeFileHash, invalidateHash, shortHash, getEntryDeps, getDepsForFile } from "./capability-resolve-hook.js";

const VALID_KINDS = new Set(["tools", "slots", "plugins"]);
const OWNER_ID = "agent-reload-coordinator";

export class AgentReloadCoordinator {
  /**
   * Tracks running agents for capability hot-reload purposes only (per-agent
   * watcher registration on agents/{id}/capabilities/, registerAgent baseline
   * for ScriptAgent src/). NOT used for scriptSrc scanning — polling needs to
   * cover agents that exist in the tree but aren't yet running (hot-create,
   * post-shutdown revival), so it iterates getAllAgentIds() instead.
   *
   * Two ID sources are intentional asymmetry: this.agents = registered/running,
   * getAllAgentIds() = exists in tree (may include shutdown / never-started).
   */
  private agents = new Map<string, BaseAgent>();
  private watchRegs: WatchRegistration[] = [];
  /** Snapshot map for flushReloads batch detection (combined hashes). */
  private flushSnapshots = new Map<string, string>();

  constructor(
    private readonly fsWatcher: FSWatcherAPI,
    private readonly pathManager: PathManagerAPI,
    /**
     * Tree-wide agent ID source for scanScriptSrc. Returns every agent
     * currently in the agent tree, including those not in this.agents (i.e.
     * not yet running). Polling uses this to detect hot-create / revival.
     */
    private readonly getAllAgentIds: () => Iterable<string>,
    /**
     * Dispatch hook injected by Scheduler. Called by scanScriptSrc when an
     * agent's src/index.ts hash drifts from baseline. Scheduler decides
     * whether to restart (if running) or init+run (if not).
     *
     * Returns true if the change was actually handled — caller may then
     * advance the baseline. Returns false if scheduler was busy with another
     * lifecycle op for this agent — caller MUST keep the prior baseline so
     * the next polling tick re-detects and retries.
     */
    private readonly scriptSrcChanged: (agentId: string) => Promise<boolean>,
  ) {}

  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.id, agent);
    this.watchAgentCapabilities(agent.id);

    // Immediately baseline ScriptAgent src/index.ts so the first content drift
    // after registration is detected by scanScriptSrc. Without this, the first
    // flushReloads call would record-and-skip, swallowing the first change
    // (especially relevant for hot-created agents whose src/ is written then immediately edited).
    const srcPath = join(this.pathManager.agent(agent.id).root(), ...SCRIPT_ENTRY_SEGMENTS);
    if (existsSync(srcPath)) {
      invalidateHash(srcPath);
      this.flushSnapshots.set(srcPath, computeFileHash(srcPath));
    }
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.fsWatcher.unregisterOwner(`${OWNER_ID}:${agentId}`);
    // NOTE: src/ baseline is intentionally NOT deleted here. Use case: agent
    // crashes → shutdownAgent → unregisterAgent. If we dropped baseline,
    // next polling scan would see prev=undefined for the same hash and trigger
    // hot-create → re-crash → infinite loop. Keeping baseline means polling
    // sees prev===hash → no trigger. User edits src/ → hash changes → normal
    // revival via scriptSrcChanged. Baseline gets overwritten by registerAgent
    // when re-init happens. Stale baselines after doRemove (tree node freed)
    // are skipped because polling iterates getAllAgentIds() which excludes them.
  }

  startWatching(): void {
    const absCapDirs = [
      this.pathManager.instance().capabilitiesDir(),
      this.pathManager.team().capabilitiesDir(),
    ];
    for (const absCapDir of absCapDirs) {
      const reg = this.fsWatcher.watchDir(
        absCapDir,
        (event) => this.onSharedCapabilityFileChanged(absCapDir, event.path),
        { ownerId: OWNER_ID, debounceMs: 500 },
      );
      this.watchRegs.push(reg);
    }
  }

  stopWatching(): void {
    for (const reg of this.watchRegs) reg.dispose();
    this.watchRegs = [];
    this.fsWatcher.unregisterOwner(OWNER_ID);
    for (const agentId of this.agents.keys()) {
      this.fsWatcher.unregisterOwner(`${OWNER_ID}:${agentId}`);
    }
    this.agents.clear();
  }

  private watchAgentCapabilities(agentId: string): void {
    const absCapDir = this.pathManager.agent(agentId).capabilitiesDir();
    this.fsWatcher.watchDir(
      absCapDir,
      (event) => this.onAgentCapabilityFileChanged(agentId, absCapDir, event.path),
      { ownerId: `${OWNER_ID}:${agentId}`, debounceMs: 500 },
    );
  }

  /**
   * Detect kind from the sub-path within a capabilities directory.
   * Expects subPath like `<pkg>/<kind>/<name>.ts` or `<pkg>/condition.ts`.
   */
  private static detectKindFromSubPath(subPath: string): "tools" | "slots" | "plugins" | "all" | null {
    const parts = subPath.split(/[\\/]/);
    if (parts.length === 2 && parts[1] === "condition.ts") return "all";
    if (parts.length === 3 && VALID_KINDS.has(parts[1]) && parts[2].endsWith(".ts")) {
      return parts[1] as "tools" | "slots" | "plugins";
    }
    return null;
  }

  /**
   * Determine which capability kinds to reload for a changed file.
   * `subPath` is relative to the capability dir (e.g. "<pkg>/tools/<name>.ts").
   * `absPath` is the absolute file path. Returns null to ignore.
   */
  private checkFileChanged(subPath: string, absPath: string): Set<string> | null {
    const kind = AgentReloadCoordinator.detectKindFromSubPath(subPath);

    // Not an entry or condition.ts — check reverse dep index
    if (!kind) {
      const dependents = getDepsForFile(absPath);
      if (dependents.size === 0) return null;
      invalidateHash(absPath);
      // Extract precise kinds from dependent entry paths (<cap>/<pkg>/<kind>/<name>.ts)
      const kinds = new Set<string>();
      for (const entry of dependents) {
        const parts = entry.split(/[\\/]/);
        const kindIdx = parts.length - 2;
        if (kindIdx >= 0 && VALID_KINDS.has(parts[kindIdx])) kinds.add(parts[kindIdx]);
      }
      return kinds.size > 0 ? kinds : VALID_KINDS;
    }

    // Entry or condition.ts — invalidate cache and trigger reload
    invalidateHash(absPath);
    return kind === "all" ? new Set(VALID_KINDS) : new Set([kind]);
  }

  /** Shared directory (instance/team) changed — reload all agents. */
  private onSharedCapabilityFileChanged(absCapDir: string, subPath: string): void {
    const kinds = this.checkFileChanged(subPath, join(absCapDir, subPath));
    if (!kinds) return;
    for (const agent of this.agents.values()) {
      for (const kind of kinds) {
        agent.reloadCapabilityKind(kind as "tools" | "slots" | "plugins")
          .catch(err => console.log(`[Coordinator] reload failed: ${(err as Error)?.message ?? err}`));
      }
    }
  }

  /** Agent-local directory changed — reload only that agent. */
  private onAgentCapabilityFileChanged(agentId: string, absCapDir: string, subPath: string): void {
    const kinds = this.checkFileChanged(subPath, join(absCapDir, subPath));
    if (!kinds) return;
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const kind of kinds) {
      agent.reloadCapabilityKind(kind as "tools" | "slots" | "plugins")
        .catch(err => console.log(`[Coordinator] reload failed for ${agentId}: ${(err as Error)?.message ?? err}`));
    }
  }

  // ─── Proactive flush (called after tool batches) ──────────────────────────

  /**
   * Scan all capability directories for changes using combined hash (entry + deps).
   * Awaits reload if anything changed. Returns true if a reload was triggered.
   */
  async flushReloads(): Promise<boolean> {
    const allIds = [...this.agents.keys()];
    const dirs: Array<[string, string[]]> = [
      [this.pathManager.instance().capabilitiesDir(), allIds],
      [this.pathManager.team().capabilitiesDir(), allIds],
      ...allIds.map(id => [this.pathManager.agent(id).capabilitiesDir(), [id]] as [string, string[]]),
    ];

    const toReload = new Map<string, Set<string>>();
    for (const [capDir, agentIds] of dirs) {
      let pkgs: import("node:fs").Dirent[];
      try { pkgs = await readdir(capDir, { withFileTypes: true }); } catch { continue; }
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        for (const kind of VALID_KINDS) {
          let files: string[];
          try { files = (await readdir(join(capDir, pkg.name, kind))).filter(f => f.endsWith(".ts")); } catch { continue; }
          for (const f of files) {
            const p = join(capDir, pkg.name, kind, f);
            invalidateHash(p);
            const eh = computeFileHash(p);

            // Compute combined hash from recorded dependency graph
            const deps = getEntryDeps(p);
            let combined = eh;
            if (deps.size > 0) {
              const depHashes = [...deps].sort().map(d => { invalidateHash(d); return computeFileHash(d); });
              combined = shortHash(eh + depHashes.join(""));
            }

            // condition.ts affects entry wrappers but is loaded separately
            // (not in import graph) — include its hash explicitly.
            const condPath = join(capDir, pkg.name, "condition.ts");
            invalidateHash(condPath);
            const condHash = computeFileHash(condPath);
            if (condHash !== "0") combined = shortHash(combined + condHash);

            const prev = this.flushSnapshots.get(p);
            if (prev === undefined) {
              // First encounter — record baseline, don't trigger reload
              this.flushSnapshots.set(p, combined);
            } else if (prev !== combined) {
              this.flushSnapshots.set(p, combined);
              for (const id of agentIds) {
                let kindSet = toReload.get(id);
                if (!kindSet) { kindSet = new Set(); toReload.set(id, kindSet); }
                kindSet.add(kind);
              }
            }
          }
        }
      }
    }

    const srcChanged = await this.scanScriptSrc();

    if (toReload.size === 0) return srcChanged;
    const reloads: Promise<void>[] = [];
    for (const [id, kinds] of toReload) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      for (const kind of kinds) reloads.push(agent.reloadCapabilityKind(kind as "tools" | "slots" | "plugins"));
    }
    await Promise.all(reloads);
    return true;
  }

  /**
   * Scan each registered agent's src/index.ts for content drift.
   *
   * Acts as the polling fallback for ScriptAgent hot-reload, compensating for
   * fs.watch's unreliability on truncate-write patterns (admin write_file etc).
   *
   * Iterates getAllAgentIds() (tree-wide), so it sees agents that aren't yet
   * running — enables hot-create / post-shutdown revival via the same path.
   *
   * Logic per agent:
   *   - src/index.ts missing → drop baseline if present, no trigger
   *   - src/index.ts present:
   *       - first encounter (prev undefined) → record baseline + trigger
   *         (registerAgent normally pre-establishes baseline at init time, so
   *          first-encounter here means src/ appeared after init — either a
   *          ConsciousAgent that just got src/index.ts written, or a never-
   *          registered tree node first reached by polling)
   *       - hash unchanged → skip
   *       - hash differs → update baseline + trigger
   *
   * No misfire on cold start: ConsciousAgents without src/ have no baseline
   * and continue to have no src/ → no trigger. Existing ScriptAgents had
   * baseline set by registerAgent during instance startup → prev !== undefined
   * on first scan → only triggers if hash actually changed.
   */
  private async scanScriptSrc(): Promise<boolean> {
    let triggered = false;
    for (const agentId of this.getAllAgentIds()) {
      const srcPath = join(this.pathManager.agent(agentId).root(), ...SCRIPT_ENTRY_SEGMENTS);
      if (!existsSync(srcPath)) {
        // src/ removed (or never existed): drop stale baseline.
        if (this.flushSnapshots.has(srcPath)) this.flushSnapshots.delete(srcPath);
        continue;
      }

      invalidateHash(srcPath);
      const hash = computeFileHash(srcPath);
      const prev = this.flushSnapshots.get(srcPath);

      if (prev === hash) continue;

      // scriptSrcChanged returns true if it actually handled the change (under
      // its lifecycle lock), false if it was busy and the change must be
      // re-detected on the next tick. Only advance baseline when handled —
      // otherwise we'd silently drop the change (busy returns + advanced
      // baseline → next scan sees prev === hash → no retry).
      try {
        const handled = await this.scriptSrcChanged(agentId);
        if (handled) {
          this.flushSnapshots.set(srcPath, hash);
          triggered = true;
        }
        // !handled: leave baseline at `prev` so next polling tick re-detects.
      } catch (err) {
        console.error(`[Coordinator] src change handling failed for '${agentId}': ${(err as Error)?.message ?? err}`);
        // Do not advance baseline on error either — let next tick retry.
      }
    }
    return triggered;
  }

}
