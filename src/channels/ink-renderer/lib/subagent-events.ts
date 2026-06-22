/**
 * Subagent event handling — formatters and accumulator helpers for subagent
 * lifecycle events (launched, task, result, error).
 *
 * Rendering is driven entirely by subagent_launched / subagent_result / subagent_error.
 * hook:toolCall and hook:toolResult for subagent are ignored by the formatter so that
 * subagentId is the sole key — no cross-event correlation needed.
 */

import type { registerFormatter as RegisterFn } from "./event-formatter.js";
import type {
  StoredEvent,
  RendererMessage,
  ToolCallMessage,
} from "../types.js";

// ── Formatters — called by event-formatter after registry is ready ──

export function registerSubagentFormatters(registerFormatter: typeof RegisterFn): void {
  registerFormatter("subagent_launched", () => null);

  registerFormatter("subagent_task", (event) => {
    const p = event.payload ?? {};
    const raw = displayContent(p.content);
    if (!raw) return null;
    const firstLine = raw.split("\n").find(l => l.trim()) ?? raw;
    const summary = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
    return { kind: "system", source: event.source ?? "", text: summary, agent: event.emitterId ?? "", timestamp: ts(event) };
  });

  registerFormatter("subagent_result", () => null);
  registerFormatter("subagent_error", () => null);
}

// ── Accumulator helper ──

/**
 * Tracks subagentId → synthetic callId mapping so subagent_result can
 * locate and update the ToolCallMessage created by subagent_launched.
 */
export class SubagentCallIndex {
  private index = new Map<string, { callId: string; args: Record<string, unknown> }>();

  set(subagentId: string, callId: string, args: Record<string, unknown>): void {
    this.index.set(subagentId, { callId, args });
  }

  getCallId(subagentId: string): string | undefined {
    return this.index.get(subagentId)?.callId;
  }

  getArgs(subagentId: string): Record<string, unknown> {
    return this.index.get(subagentId)?.args ?? {};
  }

  delete(subagentId: string): void {
    this.index.delete(subagentId);
  }
}

export interface SubagentEventResult {
  handled: boolean;
  /** A new message to push into the current turn (subagent_launched). */
  newMessage?: ToolCallMessage;
  /** An existing tool_call was updated in-place (subagent_result/error). */
  update?: { callId: string; merged: ToolCallMessage };
}

/**
 * Handle subagent lifecycle events.
 *
 * - subagent_launched → creates a new ToolCallMessage (running state)
 * - subagent_result / subagent_error → updates it to done/error state
 */
export function handleSubagentEvent(
  event: StoredEvent,
  messages: RendererMessage[],
  callIndex: SubagentCallIndex,
): SubagentEventResult {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "subagent_launched": {
      const sid = (payload.subagentId ?? "") as string;
      if (!sid) return { handled: true };

      const callId = `subagent-${sid}`;
      const task = String(payload.task ?? "");
      const type = String(payload.type ?? "");

      const msg: ToolCallMessage = {
        kind: "tool_call",
        id: callId,
        name: "subagent",
        status: "running",
        subagentId: sid,
        args: { task, type },
        agent: event.emitterId ?? "",
        timestamp: ts(event),
      };

      callIndex.set(sid, callId, msg.args as Record<string, unknown>);
      return { handled: true, newMessage: msg };
    }

    case "subagent_result":
    case "subagent_error": {
      const sid = (payload.subagentId ?? "") as string;
      if (!sid) return { handled: true };

      const callId = callIndex.getCallId(sid);
      if (!callId) return { handled: true };

      const isError = event.type === "subagent_error";
      const resultText = isError
        ? String(payload.error ?? "subagent error")
        : extractSubagentResultText(payload);

      const originalArgs = callIndex.getArgs(sid);

      // Only remove from index on result (success). On error, keep the
      // entry alive so a later subagent_result can still find it and
      // override the lifecycle safety-net error with the real outcome.
      if (!isError) {
        callIndex.delete(sid);
      }

      const inCurrent = updateToolCallInPlace(messages, callId, isError, resultText);
      if (inCurrent) {
        return { handled: true, update: { callId, merged: inCurrent } };
      }

      // tool_call already committed to a previous turn — return a patch
      // so the UI layer can find and update it by callId.
      const patch: ToolCallMessage = {
        kind: "tool_call",
        id: callId,
        name: "subagent",
        status: isError ? "error" : "done",
        resultContent: resultText,
        resultDisplay: resultText.length > 2000 ? resultText.slice(0, 2000) + "\n…" : resultText,
        args: originalArgs,
        agent: event.emitterId ?? "",
        timestamp: (event.ts as number) ?? Date.now(),
        subagentId: sid,
      };
      return { handled: true, update: { callId, merged: patch } };
    }

    default:
      return { handled: false };
  }
}

// ── Internal helpers ──

function ts(event: StoredEvent): number {
  return (event.ts as number) ?? Date.now();
}

function displayContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map(p => {
      if (p.type === "text" && p.text) return p.text as string;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractSubagentResultText(payload: Record<string, unknown>): string {
  let text = String(payload.content ?? "");
  if (text.startsWith("[{")) {
    try {
      const arr = JSON.parse(text) as Array<{ type: string; text?: string }>;
      const joined = arr.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n");
      if (joined) text = joined;
    } catch { /* use as-is */ }
  }
  return text || "[subagent completed]";
}

function updateToolCallInPlace(
  messages: RendererMessage[],
  callId: string,
  isError: boolean,
  resultText: string,
): ToolCallMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "tool_call" && (m as ToolCallMessage).id === callId) {
      const tc = m as ToolCallMessage;
      const updated: ToolCallMessage = {
        ...tc,
        status: isError ? "error" : "done",
        resultContent: resultText,
        resultDisplay: resultText.length > 2000 ? resultText.slice(0, 2000) + "\n…" : resultText,
      };
      messages[i] = updated;
      return updated;
    }
  }
  return null;
}
