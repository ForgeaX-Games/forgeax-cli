// @desc Unit tests for OpenAI-compatible conversion of media returned by tools.
import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import { messagesToOpenAI } from "../src/llm/openai-compat.js";
import type { LLMMessage } from "../src/llm/types.js";

describe("messagesToOpenAI tool media handling", () => {
  it("preserves image tool results as a follow-up user multimodal message", async () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        toolCalls: [
          { id: "call_1", name: "read_file", arguments: { path: "sprite.png" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
        toolCallId: "call_1",
        toolName: "read_file",
        toolStatus: "completed",
      },
    ];

    const converted = await messagesToOpenAI(messages);

    strictEqual(converted.length, 3);
    strictEqual(converted[1].role, "tool");
    strictEqual(converted[1].tool_call_id, "call_1");
    ok(String(converted[1].content).includes("non-text attachment"));

    strictEqual(converted[2].role, "user");
    strictEqual(converted[2].content[0].type, "text");
    strictEqual(converted[2].content[1].type, "image_url");
    strictEqual(converted[2].content[1].image_url.url, "data:image/png;base64,abc123");
  });

  it("emits all contiguous tool messages before media follow-up", async () => {
    const messages: LLMMessage[] = [
      {
        role: "tool",
        content: [{ type: "text", text: "plain result" }],
        toolCallId: "call_text",
        toolName: "read_file",
        toolStatus: "completed",
      },
      {
        role: "tool",
        content: [{ type: "image", data: "xyz", mimeType: "image/jpeg" }],
        toolCallId: "call_image",
        toolName: "read_file",
        toolStatus: "completed",
      },
    ];

    const converted = await messagesToOpenAI(messages);

    strictEqual(converted[0].role, "tool");
    strictEqual(converted[0].tool_call_id, "call_text");
    strictEqual(converted[1].role, "tool");
    strictEqual(converted[1].tool_call_id, "call_image");
    strictEqual(converted[2].role, "user");
    strictEqual(converted[2].content[1].image_url.url, "data:image/jpeg;base64,xyz");
  });
});
