/** @desc Batch tool runner — executes LLM tool calls with concurrency-aware scheduling */
import type { ToolDefinition, AgentContext } from "../../core/types.js";
import type { LLMToolCall, LLMMessage } from "../../llm/types.js";
import { Hook } from "../../hooks/types.js";
import { executeTool, resolveTool } from "./tool-executor.js";

/**
 * Partition tool calls into batches preserving order:
 * consecutive concurrent-safe calls are grouped; serial calls stand alone.
 *
 *   [C, C, S, C] → [[C,C], [S], [C]]
 */
function partition(toolCalls: LLMToolCall[], tools: ToolDefinition[]) {
  const batches: { serial: boolean; calls: LLMToolCall[] }[] = [];
  for (const tc of toolCalls) {
    const serial = resolveTool(tc.name, tools)?.serial !== false;
    if (serial) {
      batches.push({ serial: true, calls: [tc] });
    } else {
      const last = batches.at(-1);
      if (last && !last.serial) last.calls.push(tc);
      else batches.push({ serial: false, calls: [tc] });
    }
  }
  return batches;
}

export async function runToolBatch(params: {
  toolCalls: LLMToolCall[];
  tools: ToolDefinition[];
  toolCtx: AgentContext;
  materializePending: (toolCalls: LLMToolCall[]) => LLMMessage[];
  materializeResult: (toolCall: LLMToolCall, result: unknown) => LLMMessage;
  turn: number;
}): Promise<Array<{ toolCall: LLMToolCall; result: unknown; durationMs: number }>> {
  const { toolCalls, tools, toolCtx, materializePending, materializeResult } = params;
  if (toolCalls.length === 0) return [];

  const { eventBus } = toolCtx;

  for (const msg of materializePending(toolCalls)) {
    eventBus.hook(Hook.ToolCall + ":pending", { llmMessage: msg });
  }

  const dispatch = (tc: LLMToolCall) => {
    const hookEvt = eventBus.hook(Hook.ToolCall, { name: tc.name, args: tc.arguments, toolCall: tc, toolCallId: tc.id });
    if (hookEvt.isBlocked()) return Promise.resolve({ error: hookEvt.blockReason ?? "Blocked by hook observer" } as unknown);
    return executeTool(tc.name, tc.arguments, tools, toolCtx);
  };

  const commit = (tc: LLMToolCall, result: unknown, durationMs: number) => {
    const toolDef = resolveTool(tc.name, tools);
    let visualDisplay: string | undefined;
    if (toolDef?.formatDisplay) {
      try { visualDisplay = toolDef.formatDisplay(tc.arguments, result as any); }
      catch (err) { console.warn(`formatDisplay(${tc.name}) failed: ${(err as Error)?.message}`); }
    }
    const toolError = (result && typeof result === "object" && "error" in result)
      ? String((result as Record<string, unknown>).error) : undefined;

    eventBus.hook(Hook.ToolResult, {
      llmMessage: materializeResult(tc, result),
      name: tc.name, durationMs, toolCallId: tc.id,
      ...(visualDisplay ? { visual_display: visualDisplay } : {}),
      ...(toolError ? { error: toolError } : {}),
    });
    console.debug(`tool batch commit: ${tc.name} (${durationMs}ms)`);
  };

  const all: Array<{ toolCall: LLMToolCall; result: unknown; durationMs: number }> = [];

  for (const batch of partition(toolCalls, tools)) {
    if (batch.serial) {
      const tc = batch.calls[0]!;
      const t0 = Date.now();
      const result = await dispatch(tc);
      const durationMs = Date.now() - t0;
      commit(tc, result, durationMs);
      all.push({ toolCall: tc, result, durationMs });
    } else {
      const runs = batch.calls.map(async (tc) => {
        const t0 = Date.now();
        let result: unknown;
        try {
          result = await dispatch(tc);
        } catch (err) {
          result = { error: (err as Error)?.message ?? String(err) };
        }
        const durationMs = Date.now() - t0;
        commit(tc, result, durationMs);
        return { toolCall: tc, result, durationMs };
      });
      all.push(...await Promise.all(runs));
    }
  }

  return all;
}
