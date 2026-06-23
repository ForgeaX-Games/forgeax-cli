/** Kit subsystem — public surface.
 *
 *  Layout:
 *    types.ts            — KitDescriptor / KitsConfig / KitSource / PluginSource etc.
 *    name-lookup.ts      — bare ↔ qualified resolution
 *    resolve-hook.ts     — ESM hash propagation for hot-reload (idempotent register)
 *    base-registry.ts    — dual-Map (static + dynamic) BaseRegistry
 *    tool-registry.ts    — ToolRegistry
 *    slot-registry.ts    — SlotRegistry  (skeleton)
 *    plugin-registry.ts  — PluginRegistry (skeleton)
 *    base-loader.ts      — BaseKitLoader (skeleton)
 *    tool-loader.ts      — KitToolLoader (skeleton)
 *    slot-loader.ts      — KitSlotLoader (skeleton)
 *    plugin-loader.ts    — KitPluginLoader (skeleton)
 *    reload-coordinator.ts — AgentKitReloadCoordinator (skeleton)
 *
 *  All loader / registry classes pass tsc but most `_loadInternal` /
 *  `flushReloads` bodies are TODO stubs; see docs/features/runtime-rewrite-gaps.md
 *  §B1 for the porting checklist.
 */

export type {
  CapabilityBase,
  KitConditionFn,
  KitCondition,
  KitContext,
  KitDescriptor,
  KitKind,
  KitLayerId,
  KitSource,
  KitsConfig,
  PluginFactory,
  PluginSource,
  ReplaceDiff,
  SlotFactory,
} from "./types";

export { bareName, findByName } from "./name-lookup";

export {
  computeFileHash,
  invalidateHash,
  shortHash,
  ensureResolveHookRegistered,
  beginTrackEntry,
  endTrackEntry,
  getEntryDeps,
  getDepsForFile,
} from "./resolve-hook";

export { BaseRegistry } from "./base-registry";
export { ToolRegistry } from "./tool-registry";
export { SlotRegistry } from "./slot-registry";
export { PluginRegistry } from "./plugin-registry";

export {
  BaseKitLoader,
  qualifiedName,
  discoverKitPackages,
} from "./base-loader";
export { KitToolLoader } from "./tool-loader";
export { KitSlotLoader } from "./slot-loader";
export { KitPluginLoader } from "./plugin-loader";

export { AgentKitReloadCoordinator } from "./reload-coordinator";
