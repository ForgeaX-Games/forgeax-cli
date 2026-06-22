// @desc Agent.json runtime defaults and file template

import type { AgentJson } from "../../core/types.js";

/** Recursively make every nested field required — unlike built-in `Required<T>`
 *  which only un-optionals top-level fields and leaves nested optional fields
 *  (e.g. `ModelsConfig.maxRetries?: number`) intact. */
type DeepRequired<T> = T extends object
  ? { [K in keyof T]-?: DeepRequired<T[K]> }
  : T;

/**
 * Single source of truth for default agent.json values.
 *
 * - Written to disk as-is for newly created conscious agents; spread into
 *   `SCRIPT_AGENT_TEMPLATE` for ScriptAgent overrides.
 * - Referenced via `??` fallback at runtime for a few specific fields
 *   (see `conscious-agent.ts` / `micro-compaction.ts`).
 *
 * Typed as `DeepRequired<AgentJson>`: every field at every depth must appear
 * here. Callers can rely on e.g. `AGENT_DEFAULTS.models.maxRetries` being a
 * definite `number`, not `number | undefined`.
 *
 * Nested `null` values are intentional: `null` means "inherit from the global
 * agenteam.json / use provider default / skip sending the param". See
 * `ModelsConfig` field docs for per-field semantics.
 */
export const AGENT_DEFAULTS: DeepRequired<AgentJson> = {
  models: {
    model: null,
    temperature: null,
    maxTokens: null,
    reasoningEffort: "high",
    showThinking: true,
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    timeout: -1,
    routing: {
      stickiness: {
        enabled: true,
        ttlMs: 5 * 60 * 1000,
        cooldownMs: 30 * 1000,
      },
    },
  },
  coalesceMs: 300,
  maxIterations: 200,
  capabilities: {
    global: "all",
    team: "all",
    enable: [],
    disable: ["#heartbeat"],
    config: {},
  },
  session: {
    keepRecentTools: 20,
    keepRecentMedias: 2,
    idleGapMs: 20 * 60 * 1000,
  },
  timezone: "Asia/Shanghai",
  defaultDir: ".",
  defaultStatus: "",
};

/** Template for ScriptAgent — no shared capabilities by default (code-driven). */
export const SCRIPT_AGENT_TEMPLATE: AgentJson = {
  ...AGENT_DEFAULTS,
  capabilities: {
    global: "none",
    team: "none",
  },
};

