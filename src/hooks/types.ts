/** Lifecycle hook constants and payload types — emitted through EventBus */

import type { LLMMessage, LLMToolCall, StreamEvent, SystemBlock } from "../llm/types.js";
import type { EventBase, EventHandoff, EventPayload } from "../core/types.js";

/** Prefix for ephemeral stream events — not persisted to events.jsonl. */
export const STREAM_PREFIX = "stream:" as const;

// ─── Cancelable Hook Event ────────────────────────────────────────────────────
//
// All hook events carry block()/isBlocked() — analogous to DOM preventDefault().
// Callers (e.g. tool-batch-runner) check isBlocked() after publish to decide
// whether to proceed. Observers that don't call block() leave behavior unchanged.
// Hook events are always published (observer-only), never routed to queues.

export interface HookEvent extends EventBase {
  to?: undefined;
  handoff?: undefined;
  block(reason?: string): void;
  isBlocked(): boolean;
  blockReason?: string;
}

export function createHookEvent(
  type: string, payload: EventPayload, source: string,
): HookEvent {
  let blocked = false;
  const event: HookEvent = {
    source, type, payload, ts: Date.now(),
    block(r?: string) { blocked = true; event.blockReason = r; },
    isBlocked() { return blocked; },
    blockReason: undefined,
  };
  return event;
}

export const Hook = {
  AssistantMessage: "hook:assistantMessage",
  TurnStart:        "hook:turnStart",
  TurnEnd:          "hook:turnEnd",
  ToolCall:         "hook:toolCall",
  ToolResult:       "hook:toolResult",
  StreamLLM:        `${STREAM_PREFIX}llm` as const,
  SystemPrompt:     "hook:systemPrompt",
  LLMFallback:      "hook:llmFallback",
  LLMRetry:         "hook:llmRetry",
  LedgerShardChange: "hook:ledgerShardChange",

  AgentAttach:      "hook:agentAttach",
  AgentDetach:      "hook:agentDetach",
  AgentCreate:      "hook:agentCreate",
  AgentFree:        "hook:agentFree",
} as const;

export type HookType = typeof Hook[keyof typeof Hook] | `hook:${string}` | `${typeof STREAM_PREFIX}${string}`;

/** Extensible hook constants table — passed via AgentContext so plugins don't need direct imports. */
export type HookTable = typeof Hook & { readonly [k: string]: string };

export interface HookPayloadMap {
  [Hook.AssistantMessage]: {
    msg?: LLMMessage;
    llmMessage?: LLMMessage;
    turn: number;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
    providerSidecarData?: import("../llm/types.js").ProviderSidecarData;
  };
  [Hook.TurnStart]: {
    turn: number;
    eventCount: number;
  };
  [Hook.TurnEnd]: {
    turn: number;
    aborted: boolean;
    error?: string;
  };
  [Hook.ToolCall]: {
    name: string;
    args: Record<string, unknown>;
    toolCall: LLMToolCall;
  };
  [Hook.ToolResult]: {
    name: string;
    durationMs: number;
    error?: string;
  };
  [Hook.StreamLLM]: {
    chunk: StreamEvent;
    turn: number;
  };
  [Hook.SystemPrompt]: {
    /** Changed or new blocks since last emission. First emission is a full snapshot. */
    changed: SystemBlock[];
    /** Block ids removed since last emission. */
    removed?: string[];
  };
  [Hook.LLMFallback]: {
    warning: string;
  };
}
