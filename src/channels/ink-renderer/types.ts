export type { InputSegment } from "../shared/input-segments.js";
export type { StoredEvent } from "../shared/media-dir.js";
export type { RendererCallbacks } from "./lib/renderer-config.js";
export type { RendererDataSource } from "./lib/renderer-config.js";

// ── RendererMessage union ──

export interface RendererMessageBase {
  kind: string;
  agent: string;
  timestamp: number;
}

export type RendererMessage =
  | UserInputMessage
  | AssistantCompleteMessage
  | ToolCallMessage
  | ToolResultMessage
  | SystemMessage;

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
  /** Full untruncated result for progressive expansion (when resultContent is truncated). */
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
  /** Full untruncated content — only set when content was truncated. */
  fullContent?: string;
  durationMs: number;
  /** True when the tool execution failed / was aborted. */
  isError?: boolean;
}

export interface SystemMessage extends RendererMessageBase {
  kind: "system";
  source: string;
  text: string;
  visualDisplay?: string;
  level?: "info" | "warning" | "error";
  /** Direction of inter-agent traffic. Set by the fallback path for any non-hook event with content.
   *  `to` field decides: present → incoming, absent → outgoing. UI decides visual encoding. */
  direction?: "incoming" | "outgoing";
  /** Sender agent id, copied verbatim from `event.emitterId`. */
  from?: string;
  /** Recipient agent id (only present when direction === "incoming"). */
  to?: string;
}

// ── CompletedTurn ──

export interface CompletedTurn {
  agent: string;
  messages: RendererMessage[];
  timestamp: number;
  /** When true, this turn is still being built (live streaming). commitTurn replaces it. */
  _draft?: boolean;
}

// ── Overlay scheduler ──

export type OverlayLayout = "fullscreen" | "modal";

export interface SelectItem {
  label: string;
  hint?: string;
  hintColor?: string;
  disabled?: boolean;
}

export interface OverlayRequest {
  id: string;
  kind: "select" | "panel";
  layout?: OverlayLayout;
  title: string;
  items?: SelectItem[];
  loadItems?: () => Promise<SelectItem[]>;
  /** Re-fetch loadItems at this interval (ms) while the overlay is active. */
  pollMs?: number;
  onConfirm?: (idx: number, item: SelectItem) => void;
  onCancel?: () => void;
  render?: (close: () => void) => React.ReactNode;
}

// ── Slash command ──

export interface SlashCommand {
  name: string;
  description: string;
}

// ── Re-export convenience alias for React ──
import type React from "react";
