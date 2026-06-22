// @desc Tests for concurrent tool result publication.
import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { runToolBatch } from "../src/capability/tool/tool-batch-runner.js";
import type { AgentContext, EventPayload, ToolDefinition } from "../src/core/types.js";
import type { LLMMessage, LLMToolCall } from "../src/llm/types.js";
import { createHookEvent, Hook } from "../src/hooks/types.js";
import { normalizeContent } from "../src/message/modality.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function text(content: string) {
  return normalizeContent(content);
}

describe("runToolBatch", () => {
  it("publishes concurrent tool results as each call finishes while awaiting the full batch", async () => {
    const slowGate = deferred();
    const fastObserved = deferred();
    const resultEvents: string[] = [];

    const tools: ToolDefinition[] = [
      {
        name: "fast",
        description: "fast tool",
        serial: false,
        input_schema: { type: "object", properties: {} },
        async execute() { return "fast-result"; },
      },
      {
        name: "slow",
        description: "slow tool",
        serial: false,
        input_schema: { type: "object", properties: {} },
        async execute() {
          await slowGate.promise;
          return "slow-result";
        },
      },
    ];

    const toolCalls: LLMToolCall[] = [
      { id: "call_fast", name: "fast", arguments: {} },
      { id: "call_slow", name: "slow", arguments: {} },
    ];

    const ctx = {
      agentId: "test-agent",
      signal: new AbortController().signal,
      eventBus: {
        hook(type: string, payload: EventPayload) {
          if (type === Hook.ToolResult) {
            resultEvents.push(String(payload.name));
            if (payload.name === "fast") fastObserved.resolve();
          }
          return createHookEvent(type, payload, "agent:test-agent");
        },
      },
    } as unknown as AgentContext;

    let batchSettled = false;
    const batchPromise = runToolBatch({
      toolCalls,
      tools,
      toolCtx: ctx,
      materializePending: (calls) => calls.map((tc): LLMMessage => ({
        role: "tool",
        content: text(`[Pending: ${tc.name}]`),
        toolCallId: tc.id,
        toolName: tc.name,
        toolStatus: "pending",
      })),
      materializeResult: (tc, result): LLMMessage => ({
        role: "tool",
        content: text(String(result)),
        toolCallId: tc.id,
        toolName: tc.name,
        toolStatus: "completed",
      }),
      turn: 1,
    }).finally(() => { batchSettled = true; });

    await fastObserved.promise;
    strictEqual(batchSettled, false);
    deepStrictEqual(resultEvents, ["fast"]);

    slowGate.resolve();
    const results = await batchPromise;

    deepStrictEqual(resultEvents, ["fast", "slow"]);
    deepStrictEqual(results.map((r) => r.toolCall.id), ["call_fast", "call_slow"]);
  });
});
