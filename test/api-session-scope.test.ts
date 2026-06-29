/** sessionScope 中间件 —— 验证 `/api/*` 的 console.* 经 ALS sid 作用域落到
 *  对应 session 的日志,**且穿透 streamSSE 流体**(turn-trace 的真实落点)。
 *
 *  这是 "turn-trace 没被持久化" 的回归测试:根因是内核 chat 路径绕开了老
 *  Scheduler 的 runWithSession,handler/流体里的 console.debug 落 user-root
 *  fallback 而非 <sid>/logs/debug.log。中间件补上 sid 作用域后应路由正确。 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionScope } from "../src/api/lib/session-scope";
import {
  Logger,
  registerSessionLogger,
  unregisterSessionLogger,
  setGlobalLogger,
  unsetGlobalLogger,
} from "../src/core/logger";

const MARKER = "[turn-trace] kt.start sid-routed";

/** A streamSSE route that emits a turn-trace-style console.debug from INSIDE
 *  the streaming body, after an async hop — mirroring the real kernel turn. */
function mountApp(): Hono {
  const app = new Hono();
  app.use("/api/*", sessionScope());
  app.post("/api/cli/chat", (c) =>
    streamSSE(c, async (sse) => {
      await new Promise((r) => setTimeout(r, 2)); // async hop: ALS must survive it
      console.debug(MARKER);
      await sse.writeSSE({ event: "done", data: "{}" });
    }),
  );
  return app;
}

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function makeLoggers() {
  tmp = mkdtempSync(join(tmpdir(), "forgeax-sscope-"));
  const sessionLogger = new Logger({ debugLogPath: join(tmp, "sid", "logs", "debug.log") });
  const globalLogger = new Logger({ debugLogPath: join(tmp, "user", "debug.log") });
  return { sessionLogger, globalLogger };
}

describe("sessionScope middleware", () => {
  test("body sessionId routes streamSSE console.debug into <sid> session log", async () => {
    const { sessionLogger, globalLogger } = await makeLoggers();
    setGlobalLogger(globalLogger);
    registerSessionLogger("SID-A", sessionLogger);

    const res = await mountApp().request("http://x/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "SID-A", message: "hi" }),
    });
    await res.text(); // drain → streamSSE cb has fully run

    unregisterSessionLogger("SID-A", sessionLogger);
    unsetGlobalLogger(globalLogger);
    await Promise.all([sessionLogger.close(), globalLogger.close()]);

    const sessionLog = readFileSync(join(tmp, "sid", "logs", "debug.log"), "utf8");
    const userLog = readFileSync(join(tmp, "user", "debug.log"), "utf8");
    expect(sessionLog).toContain(MARKER); // landed in the right session log
    expect(userLog).not.toContain(MARKER); // NOT in user-root fallback
  });

  test("query ?sid= also establishes the scope", async () => {
    const { sessionLogger, globalLogger } = await makeLoggers();
    setGlobalLogger(globalLogger);
    registerSessionLogger("SID-Q", sessionLogger);

    const res = await mountApp().request("http://x/api/cli/chat?sid=SID-Q", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await res.text();

    unregisterSessionLogger("SID-Q", sessionLogger);
    unsetGlobalLogger(globalLogger);
    await Promise.all([sessionLogger.close(), globalLogger.close()]);

    expect(readFileSync(join(tmp, "sid", "logs", "debug.log"), "utf8")).toContain(MARKER);
  });

  test("no sid → falls back to global logger (not a session log)", async () => {
    const { sessionLogger, globalLogger } = await makeLoggers();
    setGlobalLogger(globalLogger);
    registerSessionLogger("SID-UNUSED", sessionLogger);

    const res = await mountApp().request("http://x/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "no session here" }),
    });
    await res.text();

    unregisterSessionLogger("SID-UNUSED", sessionLogger);
    unsetGlobalLogger(globalLogger);
    await Promise.all([sessionLogger.close(), globalLogger.close()]);

    const userLog = readFileSync(join(tmp, "user", "debug.log"), "utf8");
    const sessionLog = readFileSync(join(tmp, "sid", "logs", "debug.log"), "utf8");
    expect(userLog).toContain(MARKER); // sid missing → global fallback
    expect(sessionLog).not.toContain(MARKER);
  });
});
