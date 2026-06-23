/**
 * Browser-compatible event formatter — ported from ink-renderer.
 * Converts raw StoredEvents into typed RendererMessages.
 */
import type {
  StoredEvent,
  RendererMessage,
  ToolCallMessage,
  ToolResultMessage,
  SystemMessage,
  AssistantCompleteMessage,
  UserInputMessage,
} from "./types.js";

type Formatter = (event: StoredEvent) => RendererMessage | null;

const registry = new Map<string, Formatter>();

export function registerFormatter(type: string, fn: Formatter): void {
  registry.set(type, fn);
}

function displayContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: Record<string, unknown>) =>
      c.type === "text" ? String(c.text ?? "") : `[${c.type}]`
    ).join("\n");
  }
  return JSON.stringify(content);
}

function ts(event: StoredEvent): number {
  return event.ts ?? Date.now();
}

// `to === viewerId` → incoming, else outgoing.
type Direction = "incoming" | "outgoing";

function classifyDirection(event: StoredEvent, viewerId?: string): { dir: Direction; from?: string; to?: string } {
  const to = typeof event.to === "string" && event.to ? event.to : undefined;
  const from = typeof event.emitterId === "string" ? event.emitterId : undefined;
  if (to && viewerId && to === viewerId) return { dir: "incoming", from, to };
  return { dir: "outgoing", from, to };
}

function fallbackArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries.slice(0, 3).map(([k, v]) => {
    const vs = typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60) ?? "";
    return `${k}: ${vs}`;
  }).join(", ");
}

// ── Register formatters ──

// hook:* meta events (turnStart/turnEnd/error/...) carry no direction — buildDag
// drops bare system messages anyway, so produce nothing here. Same policy applies
// to session_switch / compact_boundary further down.
registerFormatter("hook:turnStart", () => null);
registerFormatter("hook:turnEnd", () => null);

registerFormatter("user_input", (e) => {
  const p = e.payload ?? {};
  const d = p.display as Record<string, unknown> | undefined;
  const text = (p.visual_display as string) ?? (d?.text as string) ?? displayContent(p.content) ?? String(p.text ?? "");
  if (!text) return null;
  const handoff = (p.handoff ?? e.handoff) as string | undefined;
  return {
    kind: "user_input",
    agent: String(e.emitterId ?? ""),
    timestamp: ts(e),
    text,
    isSteer: handoff === "steer" || Boolean(p.isSteer),
    source: String(p.source ?? e.source ?? "user"),
  } satisfies UserInputMessage;
});

registerFormatter("hook:assistantMessage", (e) => {
  const p = e.payload ?? {};
  const msg = p.llmMessage as { content?: unknown; thinking?: string } | undefined;
  if (!msg) return null;
  const text = displayContent(msg.content ?? "");
  const thinking = typeof msg.thinking === "string" ? msg.thinking.trim() : "";
  if (!text && !thinking) return null;
  return {
    kind: "assistant_complete",
    agent: String(e.emitterId ?? ""),
    timestamp: ts(e),
    text,
    thinking,
  } satisfies AssistantCompleteMessage;
});

registerFormatter("hook:toolCall", (e) => {
  const p = e.payload ?? {};
  const tc = p.toolCall as { id?: string } | undefined;
  const callId = (p.toolCallId ?? tc?.id ?? p.callId ?? p.id ?? `call_${ts(e)}`) as string;
  return {
    kind: "tool_call",
    agent: String(e.emitterId ?? ""),
    timestamp: ts(e),
    id: String(callId),
    name: String(p.name ?? p.toolName ?? "tool"),
    status: "running",
    visualDisplay: fallbackArgsSummary(p.args),
    args: p.args ?? {},
  } satisfies ToolCallMessage;
});

registerFormatter("hook:toolResult", (e) => {
  const p = e.payload ?? {};
  const errorText = p.error ? String(p.error) : "";
  const llmMsg = p.llmMessage as { content?: unknown } | undefined;
  const visualDisplay = p.visual_display ? String(p.visual_display) : undefined;
  const fullContent = errorText || (llmMsg ? displayContent(llmMsg.content) : "");
  const truncated = fullContent.length > 2000 ? fullContent.slice(0, 2000) + "\n\u2026" : fullContent;
  return {
    kind: "tool_result",
    agent: String(e.emitterId ?? ""),
    timestamp: ts(e),
    callId: String(p.toolCallId ?? p.callId ?? p.id ?? ""),
    name: String(p.name ?? p.toolName ?? ""),
    visualDisplay,
    content: truncated,
    fullContent: fullContent.length > 2000 ? fullContent : undefined,
    durationMs: Number(p.durationMs ?? 0),
    isError: !!errorText,
  } satisfies ToolResultMessage;
});

registerFormatter("session_switch", () => null);
registerFormatter("compact_boundary", () => null);

// inbound_message: already-rendered routed snapshot (the model has seen this content
// via user_input / assistantMessage / etc). Drop to avoid duplicate display.
registerFormatter("inbound_message", () => null);

// ── Main entry ──

export function formatEvent(event: StoredEvent, viewerId?: string): RendererMessage | null {
  const formatter = registry.get(event.type);
  if (formatter) return formatter(event);
  if (event.type.startsWith("subagent_")) return null;
  if (event.type.startsWith("hook:")) return null;

  // Fallback for unrecognized non-hook events (e.g. message / task_notify / agent_command):
  // emit structured direction so UI can render its own visual treatment uniformly.
  const text = displayContent(event.payload?.content ?? "");
  if (!text) return null;
  const dir = classifyDirection(event, viewerId);
  const isSelfEmit = !!viewerId && event.emitterId === viewerId;
  const source = event.source ?? "";
  // Outgoing (self-emit): show only event type. Incoming: source(type).
  const tag = isSelfEmit
    ? event.type
    : (source ? `${source}(${event.type})` : event.type);
  return {
    kind: "system",
    agent: String(event.emitterId ?? ""),
    timestamp: ts(event),
    source: tag,
    text,
    direction: dir.dir,
    from: dir.from,
    to: dir.to,
  } satisfies SystemMessage;
}
