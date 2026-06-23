// Stage E — /api/llm/test route tests.
//
// Verify:
//   - validates body (model required, prompt required, JSON parse)
//   - wraps lib/llm-gateway.complete() and shapes the success envelope
//   - on gateway throw, returns ok:false + error + latencyMs (HTTP 200 — UI
//     wants to render the error inline next to timing)
//   - system message is optional, prepended when set
//   - param plumbing: temperature / topP / maxTokens forwarded verbatim

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLlmTestRouter } from "../src/api/llm-test";
import { _resetGateway } from "../src/lib/llm-gateway";

let realFetch: typeof fetch;
let prevBaseUrl: string | undefined;
let prevKey: string | undefined;

function makeApp() {
  // Mount the router at root for testing — production mounts at /api/llm.
  // We hit /test (relative to the router) below.
  return createLlmTestRouter();
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockProxy(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
  captured: CapturedRequest[] = [],
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const req: CapturedRequest = { url, method: init?.method ?? "GET", headers, body };
    captured.push(req);
    const { status, body: respBody } = responder(req);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  prevBaseUrl = process.env.LITELLM_PROXY_BASE_URL;
  prevKey = process.env.LITELLM_PROXY_KEY;
  process.env.LITELLM_PROXY_BASE_URL = "https://test-proxy.invalid/v1";
  process.env.LITELLM_PROXY_KEY = "sk-test-1234";
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

describe("/api/llm/test", () => {
  test("rejects body without model", async () => {
    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("model");
  });

  test("rejects body without prompt", async () => {
    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("prompt");
  });

  test("rejects invalid JSON", async () => {
    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
  });

  test("happy path: wraps gateway response with text + latency + usage", async () => {
    const captured = mockProxy(() => ({
      status: 200,
      body: {
        id: "chatcmpl-x",
        model: "claude-opus-4-7-proxied",
        choices: [{ message: { content: "Hello from the proxy." } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    }));

    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        prompt: "ping",
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 64,
      }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      ok: boolean;
      text: string;
      latencyMs: number;
      transport: string;
      upstreamModel?: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
    expect(json.ok).toBe(true);
    expect(json.text).toBe("Hello from the proxy.");
    expect(json.transport).toBe("litellm");
    expect(json.upstreamModel).toBe("claude-opus-4-7-proxied");
    expect(json.usage?.totalTokens).toBe(17);
    expect(typeof json.latencyMs).toBe("number");

    // verify caller params propagated through gateway → proxy body
    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe("https://test-proxy.invalid/v1/chat/completions");
    expect(captured[0].body.model).toBe("claude-opus-4-7");
    expect(captured[0].body.temperature).toBe(0.7);
    expect(captured[0].body.top_p).toBe(0.9);
    expect(captured[0].body.max_tokens).toBe(64);
  });

  test("system message prepended to messages when supplied", async () => {
    const captured = mockProxy(() => ({
      status: 200,
      body: { choices: [{ message: { content: "ok" } }] },
    }));

    const app = makeApp();
    await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        prompt: "user line",
        system: "You are a helpful assistant.",
      }),
    });

    expect(captured[0].body.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "user line" },
    ]);
  });

  test("empty system string is skipped (no empty system message sent)", async () => {
    const captured = mockProxy(() => ({
      status: 200,
      body: { choices: [{ message: { content: "ok" } }] },
    }));

    const app = makeApp();
    await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", prompt: "hi", system: "   " }),
    });

    expect(captured[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("gateway throw → HTTP 200 with ok:false + error string + latencyMs", async () => {
    mockProxy(() => ({
      status: 400,
      body: { error: { message: "Invalid model name: bogus-x" } },
    }));

    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bogus-x", prompt: "?" }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; error: string; latencyMs: number };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Invalid model name");
    expect(typeof json.latencyMs).toBe("number");
  });

  test("missing env (no LITELLM_PROXY_KEY) surfaces as ok:false error", async () => {
    delete process.env.LITELLM_PROXY_KEY;
    const app = makeApp();
    const resp = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", prompt: "hi" }),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("LITELLM_PROXY_KEY");
  });
});
