/**
 * Browser-compatible TurnAccumulator — ported from ink-renderer.
 * Pure state machine: feeds StoredEvents, produces CompletedTurns and RendererMessages.
 */
import type { StoredEvent, RendererMessage, CompletedTurn, ToolResultMessage } from "./types.js";
import { formatEvent } from "./event-formatter.js";
import { mergeToolResult } from "./merge-tool-result.js";
import { SubagentCallIndex, handleSubagentEvent } from "./subagent-events.js";

export interface TurnAccCallbacks {
  onTurn(turn: CompletedTurn): void;
  onMessage?(msg: RendererMessage): void;
  onUpdateMessage?(callId: string, merged: RendererMessage): void;
  onMeta?(meta: { session?: string; contextPct?: number; thinking?: boolean }): void;
  onStreamText?(text: string): void;
  onThinkingText?(text: string): void;
  onResetStreaming?(): void;
}

export class TurnAccumulator {
  private cb: TurnAccCallbacks;
  private viewerId?: string;
  private currentAgent = "";
  private currentMessages: RendererMessage[] = [];
  private turnTs = 0;
  private streamText = "";
  private thinkingText = "";
  private subagentCallIndex = new SubagentCallIndex();

  constructor(callbacks: TurnAccCallbacks, viewerId?: string) {
    this.cb = callbacks;
    this.viewerId = viewerId;
  }

  feed(event: StoredEvent): void {
    const type = event.type;

    if (type === "hook:turnStart") {
      this.commitPending();
      this.currentAgent = String(event.emitterId ?? "");
      this.turnTs = event.ts ?? Date.now();
      this.streamText = "";
      this.thinkingText = "";
      this.cb.onResetStreaming?.();
      return;
    }

    if (type === "hook:turnEnd") {
      this.finalizeTurn(String(event.emitterId ?? this.currentAgent));
      return;
    }

    if (type === "session_switch") {
      this.cb.onMeta?.({ session: String(event.payload?.sessionId ?? "") });
      return;
    }

    if (type === "stream:text") {
      const chunk = String(event.payload?.text ?? event.payload?.chunk ?? "");
      this.streamText += chunk;
      this.cb.onStreamText?.(chunk);
      return;
    }

    if (type === "stream:thinking") {
      const chunk = String(event.payload?.text ?? event.payload?.chunk ?? "");
      this.thinkingText += chunk;
      this.cb.onThinkingText?.(chunk);
      this.cb.onMeta?.({ thinking: true });
      return;
    }

    if (type === "stream:thinking_end") {
      this.cb.onMeta?.({ thinking: false });
      return;
    }

    // Subagent events
    if (type.startsWith("subagent_")) {
      const result = handleSubagentEvent(event, this.currentMessages, this.subagentCallIndex);
      if (result.handled) {
        if (result.newMessage) this.pushMessage(result.newMessage);
        if (result.update) this.cb.onUpdateMessage?.(result.update.callId, result.update.merged);
        return;
      }
    }

    // Tool result merging
    const formatted = formatEvent(event, this.viewerId);
    if (!formatted) return;

    if (formatted.kind === "tool_result") {
      const merged = mergeToolResult(this.currentMessages, formatted as ToolResultMessage);
      if (merged) {
        this.cb.onUpdateMessage?.(
          (formatted as ToolResultMessage).callId,
          merged.merged,
        );
        return;
      }
    }

    this.pushMessage(formatted);
  }

  flush(): void {
    this.commitPending();
  }

  private pushMessage(msg: RendererMessage): void {
    this.currentMessages.push(msg);
    this.cb.onMessage?.(msg);
  }

  private commitPending(): void {
    if (this.currentMessages.length === 0) return;
    const turn: CompletedTurn = {
      agent: this.currentAgent,
      messages: [...this.currentMessages],
      timestamp: this.turnTs || Date.now(),
    };
    this.cb.onTurn(turn);
    this.currentMessages = [];
    this.turnTs = 0;
    this.streamText = "";
    this.thinkingText = "";
  }

  private finalizeTurn(agent: string): void {
    const turn: CompletedTurn = {
      agent: agent || this.currentAgent,
      messages: [...this.currentMessages],
      timestamp: this.turnTs || Date.now(),
    };
    this.cb.onTurn(turn);
    this.currentMessages = [];
    this.turnTs = 0;
    this.streamText = "";
    this.thinkingText = "";
    this.cb.onResetStreaming?.();
  }
}
