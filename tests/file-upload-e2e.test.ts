/**
 * End-to-end integration test for file upload through real LLM providers.
 *
 * Tests the full pipeline: createProvider → prepareInboundMessages → chatStream,
 * verifying that text_file, file (PDF), and image_file content parts are correctly
 * processed by Gemini and Anthropic APIs.
 *
 * Requires valid API keys in ~/.agenteam/key/llm_key.json
 *
 * Run:  npx tsx --test tests/file-upload-e2e.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import "../src/llm/register-all.js";
import { createProvider } from "../src/llm/provider.js";
import type { LLMMessage, StreamEvent } from "../src/llm/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(tmpdir(), `file-upload-test-${Date.now()}`);

const FIXTURES = {
  txt: { name: "sample.txt", content: "Hello from a plain text file.\nLine two." },
  json: { name: "data.json", content: JSON.stringify({ key: "value", list: [1, 2, 3] }, null, 2) },
  ts: { name: "example.ts", content: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n' },
  png: {
    name: "red-pixel.png",
    // 100x100 red PNG
    b64: "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAABFUlEQVR4nO3OUQkAIABEsetfWiv4Nx4IC7Cd7XvkByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIX4Q4gchfhDiByF+EOIHIReeLesrH9s1agAAAABJRU5ErkJggg==",
  },
  pdf: {
    name: "tiny.pdf",
    // Minimal valid PDF
    b64: "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwNgolJUVPRgo=",
  },
};

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<{ text: string; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  let text = "";
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "text") text += ev.text;
  }
  return { text, events };
}

async function runChatWithFile(
  modelSpec: string,
  content: LLMMessage["content"],
  label: string,
): Promise<{ text: string; events: StreamEvent[] }> {
  const provider = createProvider({ model: modelSpec });
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 60_000);

  const messages: LLMMessage[] = [{ role: "user", content }];

  const prepared = await provider.prepareInboundMessages!(messages, { signal: ac.signal });

  try {
    const result = await collectStream(
      provider.chatStream(undefined, prepared, [], ac.signal),
    );
    console.log(`  ✓ [${label}] got ${result.text.length} chars, ${result.events.length} events`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

before(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(fixturePath(FIXTURES.txt.name), FIXTURES.txt.content);
  await writeFile(fixturePath(FIXTURES.json.name), FIXTURES.json.content);
  await writeFile(fixturePath(FIXTURES.ts.name), FIXTURES.ts.content);
  await writeFile(fixturePath(FIXTURES.png.name), Buffer.from(FIXTURES.png.b64, "base64"));
  await writeFile(fixturePath(FIXTURES.pdf.name), Buffer.from(FIXTURES.pdf.b64, "base64"));
  console.log(`Fixtures created in ${FIXTURE_DIR}`);
});

after(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  console.log("Fixtures cleaned up");
});

// ─── Gemini Tests ─────────────────────────────────────────────────────────

describe("Gemini file upload e2e", { timeout: 120_000 }, () => {
  const model = "gemini-2.5-flash@gemini";

  it("text_file (plain text) → inlineData", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "Read this text file and tell me how many lines it has. Reply with ONLY the number." },
      { type: "text_file", path: fixturePath(FIXTURES.txt.name), mimeType: "text/plain" },
    ], "gemini/text_file/txt");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should receive text response");
  });

  it("text_file (json) → inlineData", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: 'What is the value of the "key" field in this JSON file? Reply with ONLY the value.' },
      { type: "text_file", path: fixturePath(FIXTURES.json.name), mimeType: "application/json" },
    ], "gemini/text_file/json");

    ok(events.length > 0, "should receive events");
    ok(text.includes("value"), "should read JSON content");
  });

  it("text_file (typescript) → inlineData", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "What is the name of the function exported in this TypeScript file? Reply with ONLY the function name." },
      { type: "text_file", path: fixturePath(FIXTURES.ts.name), mimeType: "text/x-typescript" },
    ], "gemini/text_file/ts");

    ok(events.length > 0, "should receive events");
    ok(text.includes("greet"), "should identify function name");
  });

  it("file (PDF) → inlineData", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "This is a PDF file. Can you confirm you received it? Reply YES or NO." },
      { type: "file", path: fixturePath(FIXTURES.pdf.name), mimeType: "application/pdf" },
    ], "gemini/file/pdf");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should receive response about PDF");
  });

  it("image_file (PNG) → inlineData", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "What color is this image? Reply with ONLY the color name." },
      { type: "image_file", path: fixturePath(FIXTURES.png.name), mimeType: "image/png" },
    ], "gemini/image_file/png");

    ok(events.length > 0, "should receive events");
    ok(text.toLowerCase().includes("red"), "should identify red pixel");
  });

  it("mixed: text + text_file + image_file", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "I'm sending you a text file and an image. Tell me: 1) how many lines the text file has, 2) the color of the image. Reply in format: lines=N, color=X" },
      { type: "text_file", path: fixturePath(FIXTURES.txt.name), mimeType: "text/plain" },
      { type: "image_file", path: fixturePath(FIXTURES.png.name), mimeType: "image/png" },
    ], "gemini/mixed");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should handle mixed content");
  });
});

// ─── Anthropic (Claude) Tests ─────────────────────────────────────────────

describe("Anthropic file upload e2e", { timeout: 120_000 }, () => {
  const model = "claude-sonnet-4-6@anthropic";

  it("text_file (plain text) → document block (text/plain)", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "Read this text file and tell me how many lines it has. Reply with ONLY the number." },
      { type: "text_file", path: fixturePath(FIXTURES.txt.name), mimeType: "text/plain" },
    ], "anthropic/text_file/txt");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should receive text response");
  });

  it("text_file (json) → inline text fallback", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: 'What is the value of the "key" field in this JSON file? Reply with ONLY the value.' },
      { type: "text_file", path: fixturePath(FIXTURES.json.name), mimeType: "application/json" },
    ], "anthropic/text_file/json");

    ok(events.length > 0, "should receive events");
    ok(text.includes("value"), "should read JSON content");
  });

  it("text_file (typescript) → inline text fallback", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "What is the name of the function exported in this TypeScript file? Reply with ONLY the function name." },
      { type: "text_file", path: fixturePath(FIXTURES.ts.name), mimeType: "text/x-typescript" },
    ], "anthropic/text_file/ts");

    ok(events.length > 0, "should receive events");
    ok(text.includes("greet"), "should identify function name");
  });

  it("file (PDF) → document block", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "This is a PDF file. Can you confirm you received it? Reply YES or NO." },
      { type: "file", path: fixturePath(FIXTURES.pdf.name), mimeType: "application/pdf" },
    ], "anthropic/file/pdf");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should receive response about PDF");
  });

  it("image_file (PNG) → image block", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "What color is this image? Reply with ONLY the color name." },
      { type: "image_file", path: fixturePath(FIXTURES.png.name), mimeType: "image/png" },
    ], "anthropic/image_file/png");

    ok(events.length > 0, "should receive events");
    ok(text.toLowerCase().includes("red"), "should identify red pixel");
  });

  it("mixed: text + text_file + image_file + file(pdf)", async () => {
    const { text, events } = await runChatWithFile(model, [
      { type: "text", text: "I'm sending you a text file, a PDF, and an image. Confirm you received all three by replying: text=OK, pdf=OK, image=OK" },
      { type: "text_file", path: fixturePath(FIXTURES.txt.name), mimeType: "text/plain" },
      { type: "file", path: fixturePath(FIXTURES.pdf.name), mimeType: "application/pdf" },
      { type: "image_file", path: fixturePath(FIXTURES.png.name), mimeType: "image/png" },
    ], "anthropic/mixed");

    ok(events.length > 0, "should receive events");
    ok(text.length > 0, "should handle mixed content");
  });
});
