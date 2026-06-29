/** /api/cli/chat SSE 烟雾测试（mock provider —— 不依赖真 claude 二进制）。
 *
 *  覆盖：
 *  - GET /api/cli/health 报告 mock provider ok
 *  - POST /api/cli/chat 走 SSE，按事件类型 emit，遇 done 自动收尾
 *  - 缺 message → 400
 *  - 缺 provider → 503
 *  - 所有响应带 Deprecation: true header */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCliRouter } from "../src/api/cli/chat";
import { _resetRegistry, registerProvider } from "../src/cli-providers/registry";
import type { CliProvider, ChatEvent } from "../src/cli-providers/types";

const MOCK_CAPS = {
  streaming: true,
  thinking: false,
  toolCalls: false,
  subAgents: false,
  sessions: false,
  jsonlReplay: false,
};

function makeMockProvider(opts: {
  id?: string;
  ok?: boolean;
  events?: ChatEvent[];
  delayMs?: number;
} = {}): CliProvider {
  const events = opts.events ?? [
    { type: "token", text: "hello" },
    { type: "token", text: " world" },
    { type: "done", stopReason: "end_turn" },
  ];
  return {
    id: (opts.id ?? "mock") as any,
    displayName: "Mock",
    capabilities: MOCK_CAPS,
    async init() {},
    async shutdown() {},
    async health() { return { ok: opts.ok ?? true, detail: "mocked" }; },
    async *chat(_req, signal) {
      for (const e of events) {
        if (signal.aborted) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield e;
      }
    },
  };
}

let app: Hono;

function mount(): Hono {
  const a = new Hono();
  a.route("/api/cli", createCliRouter());
  return a;
}

beforeEach(() => {
  _resetRegistry();
  app = mount();
});

afterEach(() => {
  _resetRegistry();
});

async function readSSEEvents(res: Response): Promise<Array<{ event: string; data: any }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: Array<{ event: string; data: any }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frame = ...\n\n
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event) out.push({ event, data: data ? JSON.parse(data) : null });
      idx = buf.indexOf("\n\n");
    }
  }
  return out;
}

describe("/api/cli/health", () => {
  test("无 provider 注册 → 503", async () => {
    const res = await app.fetch(new Request("http://localhost/api/cli/health"));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.providers).toEqual([]);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBe("forgeax-v1.0");
  });

  test("挂一个 mock provider → 200 + ok:true + 带 Deprecation header", async () => {
    registerProvider(makeMockProvider({ id: "mock-a" }), { default: true });
    const res = await app.fetch(new Request("http://localhost/api/cli/health"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providers.length).toBe(1);
    expect(body.providers[0].id).toBe("mock-a");
    expect(body.providers[0].ok).toBe(true);
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  test("provider health ok:false → 200 但顶层 ok:false", async () => {
    registerProvider(makeMockProvider({ id: "broken", ok: false }), { default: true });
    const res = await app.fetch(new Request("http://localhost/api/cli/health"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.providers[0].ok).toBe(false);
  });
});

describe("/api/cli/chat", () => {
  test("缺 message → 400", async () => {
    registerProvider(makeMockProvider(), { default: true });
    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/message/);
  });

  test("无 provider → 503", async () => {
    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.error).toMatch(/no cli-provider/);
  });

  test("provider unhealthy → 503", async () => {
    registerProvider(makeMockProvider({ ok: false }), { default: true });
    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }));
    expect(res.status).toBe(503);
  });

  test("happy path SSE 全部事件按顺序到达 + 自动停在 done", async () => {
    registerProvider(makeMockProvider({
      id: "stream-mock",
      events: [
        { type: "token", text: "alpha" },
        { type: "token", text: "beta" },
        { type: "done", stopReason: "end_turn" },
        // 应该在 done 之后被忽略
        { type: "token", text: "should-not-arrive" },
      ],
    }), { default: true });

    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    expect(res.headers.get("Deprecation")).toBe("true");

    const events = await readSSEEvents(res);
    expect(events.length).toBe(3);
    expect(events[0]!.event).toBe("token");
    expect(events[0]!.data.text).toBe("alpha");
    expect(events[1]!.data.text).toBe("beta");
    expect(events[2]!.event).toBe("done");
    expect(events[2]!.data.stopReason).toBe("end_turn");
    expect(events.every((e) => e.data.providerId === "stream-mock")).toBe(true);
  });

  test("error 事件也终止 SSE", async () => {
    registerProvider(makeMockProvider({
      events: [
        { type: "error", message: "stub error" },
        { type: "token", text: "after-error-ignored" },
      ],
    }), { default: true });

    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }));
    const events = await readSSEEvents(res);
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("error");
    expect(events[0]!.data.message).toBe("stub error");
  });

  test("providerOverride 指向已注册 provider", async () => {
    registerProvider(makeMockProvider({ id: "primary" }), { default: true });
    registerProvider(makeMockProvider({
      id: "alt",
      events: [{ type: "done", stopReason: "end_turn" }],
    }));

    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", providerOverride: "alt" }),
    }));
    const events = await readSSEEvents(res);
    expect(events[0]!.data.providerId).toBe("alt");
  });

  test("providerOverride 指向不存在的 provider → 503", async () => {
    registerProvider(makeMockProvider({ id: "primary" }), { default: true });
    const res = await app.fetch(new Request("http://localhost/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", providerOverride: "ghost" }),
    }));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.error).toMatch(/no cli-provider/);
  });
});
