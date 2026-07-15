/** LiveTurnTracker —— per-session 在途 turn 累积(多 tab 同步方案 §4.3)。
 *
 *  观察 eventBus 自累积每个 emitter 的在途流式内容;WsHub 在新连接 open 时取
 *  O(1) 快照(turn-snapshot 帧),中途加入的 tab 不用等 turn 结束才看到文本。
 *  kernel 无关:原生 runAgentLoop / runKernelTurn / CliEventBridge 三条流式
 *  路径只要往总线发 hook:turnStart / stream:llm / hook:turnEnd 就被覆盖 ——
 *  不复用 ResponseAccumulator(它是 assembleResponseWithCallback 的函数局部
 *  变量,且只覆盖原生路径)。
 *
 *  sealedTextLen / sealedThinkingLen:已被 hook:assistantMessage 封口的前缀
 *  长度(per-step seal,方案 D4)——一个 turn 内 assistantMessage 会发多条
 *  (tool-loop 每个 LLM step 一条),前端 reconcile 只修封口之后的尾部。 */

import type { EventBus } from "./event-bus";
import type { Event } from "./types";

export interface LiveToolCall {
  callId: string;
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
}

export interface TurnSnapshot {
  emitterId: string;
  turn: number;
  /** hook:turnStart 的 event.ts —— 前端流式消息身份锚 `live:<emitterId>:<ts>`。 */
  startedAt: number;
  text: string;
  thinking: string;
  sealedTextLen: number;
  sealedThinkingLen: number;
  toolCalls: LiveToolCall[];
}

interface LiveTurn {
  turn: number;
  startedAt: number;
  text: string;
  thinking: string;
  sealedTextLen: number;
  sealedThinkingLen: number;
  toolCalls: Map<string, LiveToolCall>;
}

interface StreamChunk {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: string;
  arguments_delta?: string;
}

export class LiveTurnTracker {
  private readonly turns = new Map<string, LiveTurn>();

  constructor(bus: EventBus) {
    this.disposeFn = bus.observe((event, emitterId) => this.onEvent(event, emitterId));
  }

  private readonly disposeFn: () => void;

  dispose(): void {
    this.disposeFn();
    this.turns.clear();
  }

  /** 每个在途 turn 一份快照;没有 running turn 则空数组。 */
  snapshots(): TurnSnapshot[] {
    return [...this.turns.entries()].map(([emitterId, t]) => ({
      emitterId,
      turn: t.turn,
      startedAt: t.startedAt,
      text: t.text,
      thinking: t.thinking,
      sealedTextLen: t.sealedTextLen,
      sealedThinkingLen: t.sealedThinkingLen,
      toolCalls: [...t.toolCalls.values()],
    }));
  }

  private onEvent(event: Event, emitterId?: string): void {
    if (!emitterId) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === "hook:turnStart") {
      this.turns.set(emitterId, {
        turn: typeof payload.turn === "number" ? payload.turn : 0,
        startedAt: event.ts,
        text: "",
        thinking: "",
        sealedTextLen: 0,
        sealedThinkingLen: 0,
        toolCalls: new Map(),
      });
      return;
    }

    const t = this.turns.get(emitterId);
    if (!t) return;

    switch (event.type) {
      case "stream:llm": {
        const chunk = payload.chunk as StreamChunk | undefined;
        if (!chunk) return;
        if (chunk.type === "text" && chunk.text) t.text += chunk.text;
        else if (chunk.type === "thinking" && chunk.text) t.thinking += chunk.text;
        else if (chunk.type === "tool_call" && chunk.id) {
          const prev = t.toolCalls.get(chunk.id);
          t.toolCalls.set(chunk.id, {
            callId: chunk.id,
            name: chunk.name ?? prev?.name ?? "tool",
            args: chunk.arguments ?? prev?.args,
            status: prev?.status ?? "running",
          });
        } else if (chunk.type === "tool_call_delta" && chunk.id) {
          const prev = t.toolCalls.get(chunk.id);
          const prevArgs = typeof prev?.args === "string" ? prev.args : "";
          t.toolCalls.set(chunk.id, {
            callId: chunk.id,
            name: chunk.name ?? prev?.name ?? "tool",
            args: prevArgs + (chunk.arguments_delta ?? ""),
            status: prev?.status ?? "running",
          });
        }
        return;
      }
      case "hook:toolCall": {
        const tc = payload.toolCall as { id?: string; name?: string } | undefined;
        const callId = tc?.id;
        if (!callId) return;
        t.toolCalls.set(callId, {
          callId,
          name: (payload.name as string) ?? tc?.name ?? "tool",
          args: payload.args,
          status: "running",
        });
        return;
      }
      case "hook:toolResult": {
        const callId = payload.callId as string | undefined;
        if (!callId) return;
        const prev = t.toolCalls.get(callId);
        if (prev) prev.status = payload.error ? "error" : "done";
        return;
      }
      case "hook:assistantMessage": {
        t.sealedTextLen = t.text.length;
        t.sealedThinkingLen = t.thinking.length;
        return;
      }
      case "hook:turnEnd": {
        this.turns.delete(emitterId);
        return;
      }
    }
  }
}
