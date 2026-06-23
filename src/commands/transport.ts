// @desc Commands HTTP transport — list / query / execute
//
// 对齐 agenteam ref `src/gateway/server/routes/commands.ts`：
//
//   GET  /                        → { commands: CommandSpec[] }
//   POST /:name/query             → { result: CommandResult }
//   POST /:name/execute           → { result: CommandResult }
//
// 与 ref 的差异：
//   - 没有 instanceId 路径段 —— forgeax server 是单实例的，sessionId 走 body
//     而不是 path（body.sessionId 可选，模块自己消费）。
//   - 响应包了一层 `{ result }`（与 ref 一致），让 transport 自身不区分错误码：
//     result.ok=false 时仍返 200 + body.result.error，错误是业务侧的，不是
//     HTTP 侧的。ref 在 result.ok=false 时返 500，我们这里也跟着用 500。
//   - 没有 Authorization Bearer token —— forgeax 当前 server 在 localhost only。

import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionManager } from "../core/session-manager";
import { getPathManager } from "../fs/path-manager";
import { listAllCommands, callQuery, callExecute } from "./runner";
import type { CallContext } from "./types";

interface CommandBody {
  /** 位置参数；非 string 元素 runner 入口处会 `.map(String)` 兜底。 */
  args?: unknown;
  /** forgeax sid（agenteam ref 用 path 段 instanceId 取代；我们走 body）。 */
  sessionId?: string;
  /** 调用方 agentId，可选 —— 进 ctx 给模块审计 / 权限钩子用。 */
  requestingAgentId?: string;
}

function buildCtx(body: CommandBody): CallContext {
  return {
    sm: getSessionManager(),
    paths: getPathManager(),
    sessionId: typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined,
    requestingAgentId: typeof body.requestingAgentId === "string" && body.requestingAgentId ? body.requestingAgentId : undefined,
  };
}

function normalizeArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  // ref `Array.isArray(body.args) ? (body.args as unknown[]).map(String) : []`
  return (raw as unknown[]).map((v) => (v === undefined || v === null ? "" : String(v)));
}

async function readBody(c: Context): Promise<CommandBody> {
  try {
    const raw = await c.req.text();
    return raw ? (JSON.parse(raw) as CommandBody) : {};
  } catch {
    // ref: empty/invalid body is acceptable for parameterless commands.
    return {};
  }
}

export function createCommandsRouter() {
  const r = new Hono();

  // GET /api/commands → list all available commands across layers.
  r.get("/", async (c) => {
    try {
      const ctx = buildCtx({});
      const commands = await listAllCommands(ctx);
      return c.json({ commands });
    } catch (err) {
      return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
    }
  });

  r.post("/:name/query", async (c) => {
    const name = c.req.param("name");
    const body = await readBody(c);
    const args = normalizeArgs(body.args);
    const result = await callQuery(name, args, buildCtx(body));
    return c.json({ result }, result.ok ? 200 : 500);
  });

  r.post("/:name/execute", async (c) => {
    const name = c.req.param("name");
    const body = await readBody(c);
    const args = normalizeArgs(body.args);
    const result = await callExecute(name, args, buildCtx(body));
    return c.json({ result }, result.ok ? 200 : 500);
  });

  return r;
}
