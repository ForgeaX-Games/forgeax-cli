/**
 * Phase B3 — PluginRegistry: the in-process snapshot of every loaded plugin.
 *
 * Composes scanner → merger → kind dispatcher into a single observable
 * snapshot that the HTTP API and (Phase B4) the UI consume. Reloading is
 * idempotent: callers POST /api/plugins/reload and get a fresh snapshot
 * without restarting the server.
 *
 * This sits *next to* (not on top of) `kits/plugin-registry.ts`, which is
 * the older slot/tool registry from the bus runtime. They will merge in
 * a later Phase C/D PR — see 13-MIGRATION-ROADMAP.
 */
import { scanAllLayers, type ScanError } from './scanner';
import { mergeManifests, type MergedManifest, type MergeIssue } from './merger';
import { buildKindRegistry, type KindRegistry } from './kinds';
import type { PluginLayer } from './scanner';
import { getEventBus, type EventBus } from '../events/bus';

export interface PluginSnapshot {
  /** Surrogate timestamp; bumps on every successful replaceFromManifests. */
  generation: number;
  loadedAt: number;
  manifests: MergedManifest[];
  kinds: KindRegistry;
  scanErrors: ScanError[];
  mergeIssues: MergeIssue[];
}

export interface PluginRegistryOpts {
  roots?: Partial<Record<PluginLayer, string | null>>;
}

const EMPTY: PluginSnapshot = {
  generation: 0,
  loadedAt: 0,
  manifests: [],
  kinds: {
    workbench: [],
    agents: [],
    skills: [],
    cliProviders: [],
    modelBindings: [],
    tools: [],
    issues: [],
  },
  scanErrors: [],
  mergeIssues: [],
};

let _current: PluginSnapshot = EMPTY;

export function getPluginSnapshot(): PluginSnapshot {
  return _current;
}

/**
 * Reload 后置钩子。由组合根(app boot)经 `onPluginsReloaded` 接上
 * `skills/event-bridge` 的 `syncEventTriggerBindings`。
 *
 * 为什么用钩子而非直接 import:plugins/registry 直接 import skills/event-bridge
 * 会形成运行时环 `plugins → event-bridge → runner → plugins`。反转为「registry
 * 暴露钩子、组合根接线」后,registry 对 skills/runner 子系统是 sink,环消除。
 * 未接钩子的入口(如 `forge pack` CLI)reload 时不 wire 事件触发——它本就不需要。
 */
type PluginsReloadedHook = (snapshot: PluginSnapshot, bus: EventBus) => void;
let _onReloaded: PluginsReloadedHook | null = null;
export function onPluginsReloaded(fn: PluginsReloadedHook): void {
  _onReloaded = fn;
}

/** Reload from disk. Returns the new snapshot. Failures during scan are
 *  not fatal — they're surfaced in `scanErrors` so the UI/CI can flag
 *  them while the rest of the snapshot still works. */
export async function reloadPlugins(opts: PluginRegistryOpts = {}): Promise<PluginSnapshot> {
  const scan = await scanAllLayers(opts.roots);
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  const next: PluginSnapshot = {
    generation: _current.generation + 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  };
  _current = next;
  // Doc 04 §triggers — rewire `{kind:'event'}` skill triggers against the
  // fresh snapshot, via the reload hook(组合根接的 syncEventTriggerBindings)。
  // Idempotent; the bridge tears down the previous bindings before re-adding.
  _onReloaded?.(next, getEventBus());
  return next;
}

/** Test helper — install a hand-built snapshot without reading disk. */
export function _setSnapshotForTests(snap: PluginSnapshot): void {
  _current = snap;
}

export function _resetSnapshotForTests(): void {
  _current = EMPTY;
}
