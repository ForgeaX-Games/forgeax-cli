// @desc Command system — stateless, instance-scoped types (CommandModule / Spec / Result / Context)

import type { Scheduler } from "../../core/scheduler.js";

/**
 * A CommandModule is a single `.ts` file under `commands/` (instance layer)
 * or `team/commands/` (team layer). It can register N commands via `list()`
 * and implement `query` and/or `execute` for any subset.
 *
 * Runner is stateless — every list/query/execute call re-scans the dir and
 * dynamic-imports the file with mtime cache bust. No registry, no FSWatcher,
 * no broadcast. Renderer polls list_commands when needed.
 */
export interface CommandModule {
  list(ctx: ModuleContext): Promise<CommandSpec[]>;
  /** Read-only query. `args` is positional — runner guarantees `string[]`; modules own all parsing. */
  query?(name: string, args: string[], ctx: CallContext): Promise<unknown>;
  /** Write-side execute (side effects). Same positional `args[]` convention. */
  execute?(name: string, args: string[], ctx: CallContext): Promise<unknown>;
}

export interface ModuleContext {
  scheduler: Scheduler;
  instanceDir: string;
  requestingAgentId?: string;
}

export type CallContext = ModuleContext;

/**
 * Spec broadcast to renderer. Minimal — clients learn name + description
 * (for autocomplete) and which segment(s) the command supports. Parameter
 * documentation lives in the description string; client code that invokes
 * a command knows its args layout from reading the module source.
 */
export interface CommandSpec {
  name: string;
  description: string;
  hasQuery: boolean;
  hasExecute: boolean;
}

/** Runner-wrapped result. Modules return `unknown`; throws → { ok: false }. */
export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
