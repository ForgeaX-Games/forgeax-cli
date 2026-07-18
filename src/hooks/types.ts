/** Lifecycle hook 常量与 payload 类型 —— 全部走 EventBus.publish 派发。
 *
 *  约定：
 *  - `hook:*` 前缀是「observer-only」事件命名习惯；block() / isBlocked() 不再是
 *    hook 专属 —— EventBus.publish 给每个事件都挂上了 block 通道。
 *  - `stream:*` 前缀是临时流式事件，**不**写 EventLedger（StreamLLM 是热路径，
 *    每 token 一次，落盘代价不可接受）。
 *
 *  ConsciousAgent 在 turn loop 关键点调 `boundEventBus.hook(Hook.TurnStart, ...)`
 *  —— `hook` 由 BaseAgent.boundEventBus 提供，自动带 `source: agent:<id>`；
 *  raw EventBus 不实现该方法（参考 ref core/event-bus.ts）。
 *  Hook handler 收到事件后可以 `event.block(reason)` 短路后续 observer / 路由，
 *  这就是确认对话框 / 内容审查 / ToolCall guard kit 共用的机制。 */

import type { LLMMessage, LLMToolCall, StreamEvent, SystemBlock, ProviderSidecarData } from "../llm/types";

/** Stream 事件前缀 —— 用 startsWith 判断时只看这个常量。 */
export const STREAM_PREFIX = "stream:" as const;

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

  AgentAttach:      "hook:agentAttach",
  AgentDetach:      "hook:agentDetach",
  AgentCreate:      "hook:agentCreate",
  AgentFree:        "hook:agentFree",
} as const;

export type HookType = typeof Hook[keyof typeof Hook] | `hook:${string}` | `${typeof STREAM_PREFIX}${string}`;

/** AgentContext 透传给 kit 的 hook 名常量表 —— kit 不直接 import Hook。 */
export type HookTable = typeof Hook & { readonly [k: string]: string };

export interface HookPayloadMap {
  [Hook.AssistantMessage]: {
    msg?: LLMMessage;
    llmMessage?: LLMMessage;
    turn: number;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
    providerSidecarData?: ProviderSidecarData;
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
    /** Correlates to the originating tool.call (improves UI matching beyond
     *  name+running; also keys the ledger record). */
    callId?: string;
    ok?: boolean;
    /** Full tool result payload. Persisted to the per-agent ledger so forgeax
     *  OWNS a faithful, replayable record of the turn (P0 of 历史归属/上下文所有权;
     *  prerequisite for host-owned context). Kernel-neutral: every kernel
     *  (claude-code / codex / forgeax-core) surfaces `tool.result.result`. */
    result?: unknown;
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
