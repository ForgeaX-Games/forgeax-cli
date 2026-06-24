// Stage C — llm-gateway contract tests.
//
// Verify:
//   - complete() routes to default litellm transport, builds correct
//     /v1/chat/completions body, parses response, tracks latency + usage.
//   - HTTP errors propagate as thrown Error with proxy message preserved.
//   - registerTransport + registerModelMapping let plugins override default.
//   - parseModelSpec mirrors src/llm/provider.ts (model@keySection syntax).
//   - resolveTransport picks longest prefix match, falls back to 'litellm'.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  complete,
  registerTransport,
  registerModelMapping,
  resolveTransport,
  parseModelSpec,
  listTransports,
  _resetGateway,
} from "../src/lib/llm-gateway";
import { litellmTransport } from "../src/lib/llm-gateway/transports/litellm";
import type { LlmTransport } from "../src/lib/llm-gateway/types";

let realFetch: typeof fetch;
let prevBaseUrl: string | undefined;
let prevKey: string | undefined;

beforeEach(() => {
  realFetch = globalThis.fetch;
  prevBaseUrl = process.env.LITELLM_PROXY_BASE_URL;
  prevKey = process.env.LITELLM_PROXY_KEY;
  process.env.LITELLM_PROXY_BASE_URL = "https://test-proxy.invalid/v1";
  process.env.LITELLM_PROXY_KEY = "sk-test-9999";
  _resetGateway();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevBaseUrl === undefined) delete process.env.LITELLM_PROXY_BASE_URL;
  else process.env.LITELLM_PROXY_BASE_URL = prevBaseUrl;
  if (prevKey === undefined) delete process.env.LITELLM_PROXY_KEY;
  else process.env.LITELLM_PROXY_KEY = prevKey;
  _resetGateway();
});

describe("parseModelSpec", () => {
  test("plain model id", () => {
    expect(parseModelSpec("gpt-5.5")).toEqual({ model: "gpt-5.5" });
  });
  test("with keySection suffix", () => {
    expect(parseModelSpec("claude-opus-4-7@azure-claude")).toEqual({
      model: "claude-opus-4-7",
      keySection: "azure-claude",
    });
  });
  test("@ at end → treat as plain", () => {
    expect(parseModelSpec("gpt-5.5@")).toEqual({ model: "gpt-5.5@" });
  });
  test("@ at start → treat as plain", () => {
    expect(parseModelSpec("@weird")).toEqual({ model: "@weird" });
  });
});

describe("resolveTransport / registerModelMapping", () => {
  test("default = litellm", () => {
    expect(resolveTransport("claude-opus-4-7")).toBe("litellm");
    expect(resolveTransport("gpt-5.5")).toBe("litellm");
  });

  test("longest prefix wins", () => {
    registerTransport({ name: "tA", complete: async () => ({ text: "A", model: "x", transport: "tA", latencyMs: 0 }) });
    registerTransport({ name: "tB", complete: async () => ({ text: "B", model: "x", transport: "tB", latencyMs: 0 }) });
    registerModelMapping("claude-", "tA");
    registerModelMapping("claude-opus-", "tB");
    expect(resolveTransport("claude-sonnet-4-6")).toBe("tA");
    expect(resolveTransport("claude-opus-4-7")).toBe("tB"); // longer prefix wins
  });

  test("registered transports listed", () => {
    expect(listTransports()).toEqual(["litellm"]);
    registerTransport({ name: "anthropic", complete: async () => ({ text: "", model: "", transport: "anthropic", latencyMs: 0 }) });
    expect(listTransports().sort()).toEqual(["anthropic", "litellm"]);
  });
});

describe("complete() via litellm transport", () => {
  test("happy path: builds correct request, parses response, tracks usage + latency", async () => {
    let captured: { url?: string; body?: Record<string, unknown>; auth?: string } = {};

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.body = JSON.parse(init?.body as string);
      captured.auth = (init?.headers as Record<string, string>)?.["Authorization"];
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        model: "gpt-5.5",
        choices: [{ message: { content: "hi from gpt" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const resp = await complete({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "say hi" },
      ],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 256,
    });

    expect(captured.url).toBe("https://test-proxy.invalid/v1/chat/completions");
    expect(captured.auth).toBe("Bearer sk-test-9999");
    expect(captured.body).toEqual({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "say hi" },
      ],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 256,
    });

    expect(resp.text).toBe("hi from gpt");
    expect(resp.model).toBe("gpt-5.5");
    expect(resp.transport).toBe("litellm");
    expect(resp.upstreamModel).toBe("gpt-5.5");
    expect(resp.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("HTTP 400 with structured error → throws with proxy message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: "model not allowed", type: "invalid_request_error" },
    }), { status: 400 })) as unknown as typeof fetch;

    await expect(complete({ model: "fake-model", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/model not allowed/);
  });

  test("missing env → throws helpful error", async () => {
    delete process.env.LITELLM_PROXY_KEY;
    await expect(complete({ model: "gpt-5.5", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/LITELLM_PROXY_KEY not set/);
  });

  test("non-JSON response → throws with status + snippet", async () => {
    globalThis.fetch = (async () => new Response("upstream offline", { status: 502 })) as unknown as typeof fetch;
    await expect(complete({ model: "gpt-5.5", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/non-JSON response.*upstream offline/);
  });

  test("registered transport overrides default routing for matching prefix", async () => {
    const calls: string[] = [];
    const mockTransport: LlmTransport = {
      name: "mock-anthropic",
      complete: async (req) => {
        calls.push(req.model);
        return { text: "mocked", model: req.model, transport: "mock-anthropic", latencyMs: 1 };
      },
    };
    registerTransport(mockTransport);
    registerModelMapping("claude-", "mock-anthropic");

    const resp = await complete({ model: "claude-opus-4-7", messages: [{ role: "user", content: "x" }] });
    expect(resp.transport).toBe("mock-anthropic");
    expect(resp.text).toBe("mocked");
    expect(calls).toEqual(["claude-opus-4-7"]);
  });

  test("explicit req.transport beats model-map", async () => {
    registerModelMapping("claude-", "mock-1");
    registerTransport({
      name: "mock-1",
      complete: async () => ({ text: "from-1", model: "x", transport: "mock-1", latencyMs: 0 }),
    });
    registerTransport({
      name: "mock-2",
      complete: async () => ({ text: "from-2", model: "x", transport: "mock-2", latencyMs: 0 }),
    });

    const resp = await complete({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "x" }],
      transport: "mock-2",
    });
    expect(resp.transport).toBe("mock-2");
    expect(resp.text).toBe("from-2");
  });

  test("unknown transport name → helpful error listing what's registered", async () => {
    await expect(complete({
      model: "x",
      messages: [{ role: "user", content: "x" }],
      transport: "made-up",
    })).rejects.toThrow(/no transport 'made-up' registered.*Available.*litellm/);
  });
});

describe("litellm transport direct invocation", () => {
  test("omits undefined sampler params from body", async () => {
    let body: Record<string, unknown> | undefined;
    const mockFetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), { status: 200 });
    }) as typeof fetch;

    await litellmTransport.complete(
      { model: "gpt-5.5", messages: [{ role: "user", content: "x" }] },
      { fetcher: mockFetcher },
    );

    expect(body!).toEqual({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
    });
    expect("temperature" in body!).toBe(false);
    expect("top_p" in body!).toBe(false);
    expect("max_tokens" in body!).toBe(false);
  });
});
