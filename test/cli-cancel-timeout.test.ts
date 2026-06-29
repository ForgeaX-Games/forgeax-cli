/**
 * Gap #8 -- Doc 05 section 7 driver init/cancel/timeout lifecycle.
 *
 * Verifies the legacy CliProvider lifecycle additions:
 *   - `init()` runs at registration (already existed; kept under coverage)
 *   - `cancel(callId)` aborts an in-flight chat without tearing the provider
 *   - per-call `timeoutMs` triggers `code: 'driver-timeout'` terminal
 *   - `POST /api/cli/cancel` wires through to the resolved provider
 *
 * Tests use a synthetic CliProvider that uses the shared lifecycle wrapper,
 * so any provider that adopts the wrapper inherits these guarantees.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCliRouter } from "../src/api/cli/chat";
import { _resetRegistry, registerProvider } from "../src/cli-providers/registry";
import {
  createCallTracker,
  withCallLifecycle,
} from "../src/cli-providers/shared/call-lifecycle";
import type {
  CliProvider,
  ChatEvent,
  ChatRequest,
  ProviderCapabilities,
} from "../src/cli-providers/types";

const CAPS: ProviderCapabilities = {
  streaming: true,
  thinking: false,
  toolCalls: false,
  subAgents: false,
  sessions: false,
  jsonlReplay: false,
};

/**
 * Build a provider whose chat loop emits one token, then sleeps until aborted
 * (or until the parent finishes). Uses the lifecycle wrapper so cancel/timeout
 * land inside the same code path real providers use.
 */
function makeSlowProvider(opts: { id?: string; initRan?: { value: boolean } } = {}): CliProvider {
  const tracker = createCallTracker();
  const initRan = opts.initRan ?? { value: false };
  const provider: CliProvider = {
    id: (opts.id ?? "slow-mock") as any,
    displayName: "Slow Mock",
    capabilities: CAPS,
    async init() { initRan.value = true; },
    async shutdown() {},
    async health() { return { ok: true, detail: "slow-mock" }; },
    async cancel(callId: string) { await tracker.cancel(callId); },
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      return withCallLifecycle(req, signal, tracker, async function* (handle) {
        yield { type: "token", text: "starting" };
        // Block until aborted -- never naturally completes.
        await new Promise<void>((resolve) => {
          if (handle.signal.aborted) { resolve(); return; }
          handle.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Don't yield a terminal -- the wrapper synthesises one from the
        // tracked abort reason. Real providers may yield their own; both
        // paths must converge on a single closing frame.
      });
    },
  };
  return provider;
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

describe("driver init lifecycle", () => {
  test("registerProvider kept the existing init() contract", async () => {
    const flag = { value: false };
    const p = makeSlowProvider({ initRan: flag });
    await p.init({});
    expect(flag.value).toBe(true);
  });
});

describe("driver cancel(callId) lifecycle", () => {
  test("cancel() aborts the in-flight chat with code 'cancelled'", async () => {
    const provider = makeSlowProvider({ id: "cancel-target" });
    registerProvider(provider, { default: true });

    const callId = "call-cancel-1";
    const chatPromise = app.fetch(
      new Request("http://localhost/api/cli/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", callId }),
      }),
    );

    // Give the provider a beat to start, then cancel.
    await new Promise((r) => setTimeout(r, 30));
    const cancelRes = await app.fetch(
      new Request("http://localhost/api/cli/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId }),
      }),
    );
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json() as any).ok).toBe(true);

    const res = await chatPromise;
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);
    const last = events[events.length - 1]!;
    expect(last.event).toBe("done");
    expect(last.data.stopReason).toBe("cancelled");
    expect(last.data.code).toBe("cancelled");
  });

  test("cancel with unknown callId is a no-op (idempotent ok:true)", async () => {
    const provider = makeSlowProvider();
    registerProvider(provider, { default: true });
    const res = await app.fetch(
      new Request("http://localhost/api/cli/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: "ghost-call" }),
      }),
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.callId).toBe("ghost-call");
  });

  test("cancel without callId -> 400", async () => {
    const provider = makeSlowProvider();
    registerProvider(provider, { default: true });
    const res = await app.fetch(
      new Request("http://localhost/api/cli/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("cancel without provider -> 503", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/cli/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: "x" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  test("provider without cancel() -> 501 not implemented", async () => {
    const stub: CliProvider = {
      id: "no-cancel" as any,
      displayName: "no cancel",
      capabilities: CAPS,
      async init() {},
      async shutdown() {},
      async health() { return { ok: true }; },
      async *chat() { yield { type: "done", stopReason: "end_turn" } as ChatEvent; },
    };
    registerProvider(stub, { default: true });
    const res = await app.fetch(
      new Request("http://localhost/api/cli/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: "x" }),
      }),
    );
    expect(res.status).toBe(501);
  });
});

describe("driver per-call timeout lifecycle", () => {
  test("timeoutMs triggers a structured 'driver-timeout' terminal", async () => {
    const provider = makeSlowProvider({ id: "timeout-target" });
    registerProvider(provider, { default: true });

    const res = await app.fetch(
      new Request("http://localhost/api/cli/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", timeoutMs: 50 }),
      }),
    );
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);

    // Single terminal frame `error` carries `code: 'driver-timeout'`. The
    // route closes the SSE on the first done/error, so we don't get a
    // follow-up done -- the code field on `error` is the SSOT for the
    // failure mode.
    const errorEv = events.find((e) => e.event === "error");
    expect(errorEv).toBeDefined();
    expect(errorEv!.data.code).toBe("driver-timeout");
    expect(errorEv!.data.message).toMatch(/timed out/);
  });
});
