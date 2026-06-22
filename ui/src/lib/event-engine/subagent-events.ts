/**
 * Browser-compatible subagent event handling — ported from ink-renderer.
 */
import type { StoredEvent, RendererMessage, ToolCallMessage } from "./types.js";

function ts(event: StoredEvent): number {
  return event.ts ?? Date.now();
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

function extractSubagentResultText(payload: Record<string, unknown>): string {
  const result = payload.result as Record<string, unknown> | string | undefined;
  if (!result) return payload.error ? `Error: ${payload.error}` : "(no result)";
  if (typeof result === "string") return result;
  const content = (result as Record<string, unknown>).content;
  return displayContent(content) || JSON.stringify(result).slice(0, 200);
}

export class SubagentCallIndex {
  private index = new Map<string, string>();

  set(subagentId: string, callId: string): void {
    this.index.set(subagentId, callId);
  }

  getCallId(subagentId: string): string | undefined {
    return this.index.get(subagentId);
  }

  delete(subagentId: string): void {
    this.index.delete(subagentId);
  }
}

export interface SubagentEventResult {
  handled: boolean;
  newMessage?: ToolCallMessage;
  update?: { callId: string; merged: ToolCallMessage };
}

function updateToolCallInPlace(
  messages: RendererMessage[],
  callId: string,
  isError: boolean,
  resultText: string,
): ToolCallMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "tool_call" && (m as ToolCallMessage).id === callId) {
      const merged: ToolCallMessage = {
        ...(m as ToolCallMessage),
        status: isError ? "error" : "done",
        resultContent: resultText,
      };
      messages[i] = merged;
      return merged;
    }
  }
  return null;
}

export function handleSubagentEvent(
  event: StoredEvent,
  messages: RendererMessage[],
  callIndex: SubagentCallIndex,
): SubagentEventResult {
  const p = event.payload ?? {};

  if (event.type === "subagent_launched") {
    const subId = String(p.subagentId ?? "");
    const callId = String(p.callId ?? "");
    if (subId && callId) callIndex.set(subId, callId);
    return { handled: true };
  }

  if (event.type === "subagent_task") {
    const subId = String(p.subagentId ?? "");
    const callId = callIndex.getCallId(subId) || `sub_${subId}`;
    const name = String(p.taskDescription ?? p.template ?? "subagent");
    const msg: ToolCallMessage = {
      kind: "tool_call",
      agent: String(event.emitterId ?? ""),
      timestamp: ts(event),
      id: callId,
      name: `subagent: ${name}`,
      status: "running",
      args: { subagentId: subId, template: p.template },
      subagentId: subId,
    };
    return { handled: true, newMessage: msg };
  }

  if (event.type === "subagent_result") {
    const subId = String(p.subagentId ?? "");
    const callId = callIndex.getCallId(subId);
    if (!callId) return { handled: false };
    const resultText = extractSubagentResultText(p);
    const merged = updateToolCallInPlace(messages, callId, false, resultText);
    callIndex.delete(subId);
    if (merged) return { handled: true, update: { callId, merged } };
    return { handled: true };
  }

  if (event.type === "subagent_error") {
    const subId = String(p.subagentId ?? "");
    const callId = callIndex.getCallId(subId);
    if (!callId) return { handled: false };
    const errorText = String(p.error ?? "Subagent error");
    const merged = updateToolCallInPlace(messages, callId, true, errorText);
    callIndex.delete(subId);
    if (merged) return { handled: true, update: { callId, merged } };
    return { handled: true };
  }

  return { handled: false };
}
