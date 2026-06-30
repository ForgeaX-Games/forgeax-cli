/** Kit system public types.
 *
 *  A "kit" is what agenteam-os calls a "capability package": a directory under
 *  `<layer>/kits/<kit-name>/` containing `tools/ slots/ plugins/ lib/` plus an
 *  optional `condition.ts`. Per-kit `condition.ts` gates the whole kit and
 *  may export `configDefaults` / `agentDefaults` for first-time merge into
 *  the agent's overrides file.
 *
 *  Layer overlay (last wins) — see docs/features/runtime-rewrite-feature-map.md §4:
 *    builtin → user → session → agent
 *
 *  Override semantics are **whole-kit**: a kit existing at a higher layer
 *  fully replaces lower layers (no per-file Frankenstein merging).
 *
 *  Names:
 *    - Storage key  → qualified `kit/kind/name` (e.g. `workspace/tools/read_file`)
 *    - LLM-facing   → bare `name` when unambiguous across the registry,
 *                     otherwise qualified (`/` is rejected by Anthropic /
 *                     OpenAI tool-name validators, so on bare-collision
 *                     ConsciousAgent drops the group). */

import type { AgentContext } from "../core/types";
import type { ContextSlot } from "./slot/types";

// ─── Kit discovery primitives ────────────────────────────────────────────────

export type KitKind = "tools" | "slots" | "plugins";

/** Source layer id. `"agent"` = per-agent override; named layers are global. */
export type KitLayerId = "builtin" | "user" | "session" | "agent";

export interface KitSource {
  /** Display id; informational only. */
  id: KitLayerId;
  /** Absolute path to the `kits/` root of this layer. */
  dir: string;
}

export interface KitDescriptor {
  /** Bare file name without `.ts`. */
  name: string;
  /** Kit package directory name (e.g. `workspace`). */
  pkg: string;
  /** `tools` | `slots` | `plugins`. */
  kind: KitKind;
  /** Absolute path to the `.ts` file. */
  path: string;
  /** Source layer this descriptor was scanned from. */
  layer: KitLayerId;
}

// ─── Kit visibility config (lives on AgentJson.kits) ────────────────────────

/**
 * Token formats (processed `enable` first, then `disable`):
 *   "name"             — bare kit-item name (`read_file`)
 *   "#kit"             — whole kit (`#workspace`)
 *   "kit/kind/name"    — fully qualified (`workspace/tools/read_file`)
 *   "kit/kind/*"       — wildcard within kit
 */
export interface KitsConfig {
  /** Toggle whether user-layer kits load by default (per-agent override). */
  user?: "all" | "none";
  /** Toggle whether session-layer kits load by default. */
  session?: "all" | "none";

  enable?: string[];
  disable?: string[];

  /** Per-kit runtime config: `config[kit][configKey] = value`.
   *  Merged from `configDefaults` exported by each kit's `condition.ts`. */
  config?: Record<string, Record<string, unknown>>;
}

// ─── Capability base (shared by tools / slots / plugins) ─────────────────────

export interface CapabilityBase {
  name: string;
  description?: string;
  /** Per-turn visibility predicate. `self` is the capability instance itself. */
  condition?: (ctx: AgentContext, self?: CapabilityBase) => boolean;
}

// ─── Plugin types ────────────────────────────────────────────────────────────

export interface PluginSource extends CapabilityBase {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type PluginFactory = (ctx: AgentContext) => PluginSource;

// ─── Slot factory (slot itself is defined in kits/slot/types.ts) ────────────

export type SlotFactory = (ctx: AgentContext) => ContextSlot;

// ─── Kit-facing context (alias — full surface lives on core AgentContext) ────

export type KitContext = AgentContext;

// ─── Kit condition export (`condition.ts` shape) ─────────────────────────────

export type KitConditionFn = (ctx: AgentContext) => boolean;

export interface KitCondition {
  default?: KitConditionFn;
  condition?: KitConditionFn;
  configDefaults?: Record<string, Record<string, unknown>>;
  agentDefaults?: Record<string, unknown>;
}

// ─── Diff record returned by registry.replaceStatic ──────────────────────────

export interface ReplaceDiff {
  readonly added: Set<string>;
  readonly removed: Set<string>;
  readonly changed: Set<string>;
  readonly dirty: boolean;
}
