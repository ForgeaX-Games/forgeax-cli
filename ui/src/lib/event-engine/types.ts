/**
 * Browser-compatible event engine types — ported from ink-renderer.
 * No Node.js dependencies.
 */

/**
 * Persisted form of a bus Event. `emitterId` is captured by EventBus at emit() time.
 * Ledger owner is implied by API path / WebSocket subscription — not stored on each event.
 */
export interface StoredEvent {
  type: string;
  ts: number;
  source?: string;
  to?: string;
  emitterId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RendererMessageBase {
  kind: string;
  agent: string;
  timestamp: number;
}

export interface UserInputMessage extends RendererMessageBase {
  kind: "user_input";
  text: string;
  isSteer: boolean;
  source: string;
}

export interface AssistantCompleteMessage extends RendererMessageBase {
  kind: "assistant_complete";
  text: string;
  thinking: string;
}

export type ToolStatus = "pending" | "running" | "done" | "error";

export interface ToolCallMessage extends RendererMessageBase {
  kind: "tool_call";
  id: string;
  name: string;
  status: ToolStatus;
  visualDisplay?: string;
  args: unknown;
  resultDisplay?: string;
  resultContent?: string;
  fullResultContent?: string;
  durationMs?: number;
  subagentId?: string;
}

export interface ToolResultMessage extends RendererMessageBase {
  kind: "tool_result";
  callId: string;
  name: string;
  visualDisplay?: string;
  content: string;
  fullContent?: string;
  durationMs: number;
  isError?: boolean;
}

export interface SystemMessage extends RendererMessageBase {
  kind: "system";
  source: string;
  text: string;
  visualDisplay?: string;
  level?: "info" | "warning" | "error";
  /** to===viewerId → incoming, else outgoing. */
  direction?: "incoming" | "outgoing";
  from?: string;
  to?: string;
}

export type RendererMessage =
  | UserInputMessage
  | AssistantCompleteMessage
  | ToolCallMessage
  | ToolResultMessage
  | SystemMessage;

export interface CompletedTurn {
  agent: string;
  messages: RendererMessage[];
  timestamp: number;
  _draft?: boolean;
}
