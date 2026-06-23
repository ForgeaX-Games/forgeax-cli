// @desc Unit tests for OpenAI Responses adapter — multimodal tool output, reasoning skip, instructions partition.
import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { messagesToResponseInput } from "../src/llm/openai-response.js";
import type { LLMMessage } from "../src/llm/types.js";

describe("messagesToResponseInput tool result handling", () => {
  it("emits image tool results inline as a function_call_output content list (native multimodal)", async () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        toolCalls: [
          { id: "call_1", name: "read_image", arguments: { path: "sprite.png" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
        toolCallId: "call_1",
        toolName: "read_image",
        toolStatus: "completed",
      },
    ];

    const input = await messagesToResponseInput(messages);

    // No `message` item for empty assistant text; only the function_call.
    const fnCall = input.find((it) => it.type === "function_call");
    ok(fnCall, "function_call item missing");
    strictEqual(fnCall.call_id, "call_1");
    strictEqual(fnCall.name, "read_image");
    strictEqual(fnCall.arguments, JSON.stringify({ path: "sprite.png" }));

    const fnOut = input.find((it) => it.type === "function_call_output");
    ok(fnOut, "function_call_output item missing");
    strictEqual(fnOut.call_id, "call_1");
    ok(Array.isArray(fnOut.output), "output should be a content list for image-bearing tool result");
    const imgPart = (fnOut.output as any[]).find((p) => p.type === "input_image");
    ok(imgPart, "expected input_image part in tool output");
    strictEqual(imgPart.image_url, "data:image/png;base64,abc123");
  });

  it("uses string form for text-only tool results", async () => {
    const messages: LLMMessage[] = [
      {
        role: "tool",
        content: [{ type: "text", text: "plain result" }],
        toolCallId: "call_text",
        toolName: "read_file",
        toolStatus: "completed",
      },
    ];

    const input = await messagesToResponseInput(messages);
    strictEqual(input.length, 1);
    strictEqual(input[0].type, "function_call_output");
    strictEqual(input[0].call_id, "call_text");
    strictEqual(input[0].output, "plain result");
  });

  it("emits each consecutive tool result as its own item, preserving call_id pairing", async () => {
    const messages: LLMMessage[] = [
      {
        role: "tool",
        content: [{ type: "text", text: "first" }],
        toolCallId: "call_a",
        toolName: "read_file",
        toolStatus: "completed",
      },
      {
        role: "tool",
        content: [{ type: "image", data: "xyz", mimeType: "image/jpeg" }],
        toolCallId: "call_b",
        toolName: "read_file",
        toolStatus: "completed",
      },
    ];

    const input = await messagesToResponseInput(messages);
    strictEqual(input.length, 2);
    strictEqual(input[0].call_id, "call_a");
    strictEqual(input[0].output, "first");
    strictEqual(input[1].call_id, "call_b");
    ok(Array.isArray(input[1].output));
    const img = (input[1].output as any[]).find((p) => p.type === "input_image");
    ok(img);
    strictEqual(img.image_url, "data:image/jpeg;base64,xyz");
  });
});

describe("messagesToResponseInput assistant + reasoning behavior", () => {
  it("does NOT emit reasoning items in the input array (store=false reasoning ids unportable)", async () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "Q" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "A" }],
        thinking: "I should think carefully here.",
      },
      { role: "user", content: [{ type: "text", text: "Follow up" }] },
    ];

    const input = await messagesToResponseInput(messages);
    const reasoningItems = input.filter((it) => it.type === "reasoning");
    strictEqual(reasoningItems.length, 0, "reasoning items must not be emitted");

    // Assistant text replay must use the `message` + `output_text` shape.
    const msgItem = input.find((it) => it.type === "message" && it.role === "assistant");
    ok(msgItem);
    strictEqual(msgItem.content[0].type, "output_text");
    strictEqual(msgItem.content[0].text, "A");
  });

  it("splits assistant message + tool calls into separate top-level items", async () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Calling tool now." }],
        toolCalls: [
          { id: "call_x", name: "lookup", arguments: { n: 42 } },
          { id: "call_y", name: "lookup", arguments: { n: 7 } },
        ],
      },
    ];

    const input = await messagesToResponseInput(messages);
    strictEqual(input.length, 3, "expect 1 message + 2 function_call items");
    strictEqual(input[0].type, "message");
    strictEqual(input[0].role, "assistant");
    strictEqual(input[1].type, "function_call");
    strictEqual(input[1].call_id, "call_x");
    strictEqual(input[2].type, "function_call");
    strictEqual(input[2].call_id, "call_y");
  });

  it("omits empty-text assistant messages (only tool calls survive)", async () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        toolCalls: [{ id: "call_only", name: "ping", arguments: {} }],
      },
    ];

    const input = await messagesToResponseInput(messages);
    strictEqual(input.length, 1, "empty text must not produce a message item");
    strictEqual(input[0].type, "function_call");
  });

  it("uses input_text content type for user messages (NOT chat-completions 'text')", async () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const input = await messagesToResponseInput(messages);
    strictEqual(input.length, 1);
    strictEqual(input[0].role, "user");
    deepStrictEqual(input[0].content, [{ type: "input_text", text: "hello" }]);
  });
});

describe("messagesToResponseInput drops pending tool messages", () => {
  it("does not emit function_call_output for in-flight (pending) tool messages", async () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        toolCalls: [{ id: "call_p", name: "slow_op", arguments: {} }],
      },
      {
        role: "tool",
        content: [{ type: "text", text: "[Pending: slow_op]" }],
        toolCallId: "call_p",
        toolName: "slow_op",
        toolStatus: "pending",
      },
    ];

    const input = await messagesToResponseInput(messages);
    const fnOut = input.find((it) => it.type === "function_call_output");
    strictEqual(fnOut, undefined, "pending tool result must not be emitted");
    const fnCall = input.find((it) => it.type === "function_call");
    ok(fnCall, "the function_call should still be emitted");
  });
});
