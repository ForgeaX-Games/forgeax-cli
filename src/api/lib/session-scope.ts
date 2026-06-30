/** sessionScope —— `/api/*` 的 ALS session 作用域中间件。
 *
 *  问题背景:`core/logger.ts` 的 console bridge 按 ALS `LogContext.sid` 把
 *  `console.*` 路由进 `<sid>/logs/debug.log`。但建立这个 sid scope 的
 *  `runWithSession(...)` 此前**只**在老的 `core/scheduler.ts`(Scheduler→
 *  ConsciousAgent)路径里。默认主对话走内核路径(`kernelEnabled()` 默认开),
 *  `/api/cli/chat` 直接在 Hono handler 里 `kernel.runTurn(...)`,绕开 Scheduler,
 *  栈上没有 sid scope ⇒ turn-trace / handler 的 `console.*` 全落 user-root
 *  fallback(`debug.log`),进不了对应 session 的日志(turn-trace 改走通用
 *  console 通道、删独立 turn-trace.log 之后,这表现为"日志没被持久化")。
 *
 *  修复:在 `/api/*` 统一加一道中间件,从请求里解析 sid 并把整个 handler
 *  (含其 `streamSSE` 流体)包进 `runWithSession(sid, …)`。bridge 即可拿到 sid,
 *  console.* 落到正确的 session 日志。同时修掉同路径下其它 handler 的 `console.*`
 *  落不进 session 日志的同类问题。
 *
 *  ALS × Hono streaming 正确性(已用探针证实):Hono 的 `streamSSE(c, cb)` 是
 *  **eager / producer-driven** —— 同步 fire-and-forget 调 `run(stream, cb)`,
 *  `cb` 在 handler 的 async 上下文里被启动,因此 ALS store 顺着 await 链(含
 *  backpressure write、setTimeout/setImmediate 续体)一路传进 `cb` 里的 `tt()`。
 *  这与"pull-driven ReadableStream 由运行时 I/O 触发 → 丢 ALS"那个坑不同。
 *
 *  sid 解析来源(命中即止):
 *    1. query `?sid=` / `?sessionId=`
 *    2. 路径 `/api/sessions/<sid>/…`(session-scoped REST 家族)
 *    3. JSON body `sessionId`(仅 content-type 含 application/json;chat 走这条)
 *
 *  body 读取安全性(已证实):Hono v4 缓存 `c.req.json()`,中间件读 body 取 sid
 *  不影响 handler 再读;畸形 JSON 在此 swallow,handler 自己的 `c.req.json()`
 *  仍会失败并返它自己的 400(无缓存污染)。无 sid ⇒ 透传 `next()`(无副作用)。 */

import type { MiddlewareHandler } from "hono";
import { runWithSession } from "../../core/logger";

const SESSIONS_PATH_RE = /^\/api\/sessions\/([^/]+)/;

async function resolveSid(c: Parameters<MiddlewareHandler>[0]): Promise<string | undefined> {
  const q = c.req.query("sid")?.trim() || c.req.query("sessionId")?.trim();
  if (q) return q;

  const m = SESSIONS_PATH_RE.exec(c.req.path);
  if (m?.[1]) return decodeURIComponent(m[1]);

  // body sid —— 仅 JSON 请求才 peek,避免消费 multipart/二进制上传体。
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = (await c.req.json()) as { sessionId?: unknown };
      if (typeof body?.sessionId === "string" && body.sessionId.trim()) {
        return body.sessionId.trim();
      }
    } catch {
      /* malformed / empty body —— swallow;handler 自己会校验并报 400 */
    }
  }
  return undefined;
}

/** `/api/*` 中间件:解析 sid 并把 handler(含 streamSSE 流体)包进
 *  `runWithSession(sid, …)`,使其 `console.*` 经 bridge 落对应 session 日志。 */
export function sessionScope(): MiddlewareHandler {
  return async (c, next) => {
    const sid = await resolveSid(c);
    return sid ? runWithSession(sid, () => next()) : next();
  };
}
