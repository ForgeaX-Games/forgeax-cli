// @desc Tests for /api/commands HTTP transport (list / query / execute)
//
// Body shape: `{ args?: string[], sessionId?, requestingAgentId? }`
// Response shape: `{ result: { ok: true, data } | { ok: false, error } }`

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import { createCommandsApiRouter } from "../src/api/commands";

let userRoot: string;
let commandsDir: string;
let prevCmdDir: string | undefined;
let app: Hono;

function writeMod(file: string, body: string): void {
  writeFileSync(resolve(commandsDir, file), body, "utf-8");
}

function mountApp(): Hono {
  const a = new Hono();
  a.route("/api/commands", createCommandsApiRouter());
  return a;
}

interface CallResult { status: number; json: any }
async function get(path: string): Promise<CallResult> {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return { status: res.status, json: await res.json() };
}
async function post(path: string, body?: unknown): Promise<CallResult> {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-cmd-tx-"));
  commandsDir = mkdtempSync(resolve(tmpdir(), "forgeax-cmd-tx-dir-"));
  prevCmdDir = process.env.FORGEAX_COMMANDS_DIR;
  process.env.FORGEAX_COMMANDS_DIR = commandsDir;
  resetPathManager();
  await resetSessionManager();
  const pm = initPathManager({ userRoot });
  initSessionManager(pm);
  app = mountApp();
});

afterEach(async () => {
  if (prevCmdDir === undefined) delete process.env.FORGEAX_COMMANDS_DIR;
  else process.env.FORGEAX_COMMANDS_DIR = prevCmdDir;
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
  rmSync(commandsDir, { recursive: true, force: true });
});

describe("GET /api/commands —— list", () => {
  test("空目录 → { commands: [] }", async () => {
    const r = await get("/api/commands");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ commands: [] });
  });

  test("发现 modules + 含 _error spec", async () => {
    writeMod("ok.ts", `
      const mod = {
        async list() { return [{ name: "ok-cmd", description: "ok", hasQuery: true, hasExecute: false }]; },
        async query() { return null; },
      };
      export default mod;
    `);
    writeMod("bad.ts", `not even js`);
    const r = await get("/api/commands");
    expect(r.status).toBe(200);
    expect(r.json.commands.map((s: any) => s.name).sort()).toEqual([
      "_error:bad.ts",
      "ok-cmd",
    ].sort());
  });
});

describe("POST /api/commands/:name/query", () => {
  test("happy path → { result: { ok:true, data } }", async () => {
    writeMod("e.ts", `
      const mod = {
        async list() { return [{ name: "echo", description: "e", hasQuery: true, hasExecute: false }]; },
        async query(_n: string, args: string[]) { return { args, count: args.length }; },
      };
      export default mod;
    `);
    const r = await post("/api/commands/echo/query", { args: ["x", "y", "z"] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ result: { ok: true, data: { args: ["x", "y", "z"], count: 3 } } });
  });

  test("空 body 安全 —— args 缺省 []", async () => {
    writeMod("p.ts", `
      const mod = {
        async list() { return [{ name: "p", description: "p", hasQuery: true, hasExecute: false }]; },
        async query(_n: string, args: string[]) { return { len: args.length }; },
      };
      export default mod;
    `);
    const r = await post("/api/commands/p/query");
    expect(r.status).toBe(200);
    expect(r.json.result.data.len).toBe(0);
  });

  test("非 string args 元素被 String() 兜底", async () => {
    writeMod("s.ts", `
      const mod = {
        async list() { return [{ name: "s", description: "s", hasQuery: true, hasExecute: false }]; },
        async query(_n: string, args: string[]) { return args; },
      };
      export default mod;
    `);
    const r = await post("/api/commands/s/query", { args: [1, true, null, undefined, "ok"] });
    expect(r.status).toBe(200);
    expect(r.json.result.data).toEqual(["1", "true", "", "", "ok"]);
  });

  test("Unknown command → 500 + { result: { ok:false, error } }", async () => {
    const r = await post("/api/commands/ghost/query");
    expect(r.status).toBe(500);
    expect(r.json.result).toEqual({ ok: false, error: "Unknown command: ghost" });
  });

  test("命令只有 execute → 500 has-no-query", async () => {
    writeMod("wo.ts", `
      const mod = {
        async list() { return [{ name: "wo", description: "w", hasQuery: false, hasExecute: true }]; },
        async execute() { return {}; },
      };
      export default mod;
    `);
    const r = await post("/api/commands/wo/query");
    expect(r.status).toBe(500);
    expect(r.json.result.error).toMatch(/has no query/);
  });

  test("模块抛错 → 500 + 错误信息透传", async () => {
    writeMod("b.ts", `
      const mod = {
        async list() { return [{ name: "b", description: "b", hasQuery: true, hasExecute: false }]; },
        async query() { throw new Error("kaboom!"); },
      };
      export default mod;
    `);
    const r = await post("/api/commands/b/query");
    expect(r.status).toBe(500);
    expect(r.json.result.error).toBe("kaboom!");
  });
});

describe("POST /api/commands/:name/execute", () => {
  test("happy path execute", async () => {
    writeMod("d.ts", `
      const mod = {
        async list() { return [{ name: "d", description: "d", hasQuery: false, hasExecute: true }]; },
        async execute(_n: string, args: string[]) { return { changed: args[0] }; },
      };
      export default mod;
    `);
    const r = await post("/api/commands/d/execute", { args: ["target"] });
    expect(r.status).toBe(200);
    expect(r.json.result.data).toEqual({ changed: "target" });
  });

  test("sessionId + requestingAgentId 透传到 ctx", async () => {
    writeMod("a.ts", `
      const mod = {
        async list() { return [{ name: "a", description: "a", hasQuery: false, hasExecute: true }]; },
        async execute(_n: string, _a: string[], ctx: any) {
          return { sid: ctx.sessionId, agent: ctx.requestingAgentId };
        },
      };
      export default mod;
    `);
    const r = await post("/api/commands/a/execute", {
      args: [],
      sessionId: "sid-xyz",
      requestingAgentId: "root#1",
    });
    expect(r.status).toBe(200);
    expect(r.json.result.data).toEqual({ sid: "sid-xyz", agent: "root#1" });
  });
});
