// @desc Session routes — multi-session HTTP API.
//
// Endpoints (all under /api/instances/:id/sessions):
//
//   POST   /                       → create session
//   GET    /                       → list sessions
//   POST   /:sid/emit              → publish event to session bus
//   DELETE /:sid                   → dispose session
//
// All operations are session-scoped: emit lands in the SessionRuntime's
// own EventBus, and ledger I/O lives under sessions/<sid>/<agentId>/.
// Legacy /api/instances/:id/emit still routes to the "default" session
// for unchanged forgeax-studio servers.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import type { Event, InstanceHandle } from "../../../core/types.js";
import { json, parseJsonBody } from "./utils.js";

interface CreateSessionBody {
  sessionId?: string;
  rootKind?: string;
  title?: string;
}

/**
 * Worker-side calls reach the SessionRegistry through the IPC proxy.
 * `instance-worker.ts` exposes them via the METHODS table; the IPC handle
 * routes any method name not in `localHandle` to `_rpc`, so the call below
 * crosses into the worker without an explicit declaration.
 */
type WorkerRpcHandle = InstanceHandle & {
  // METHODS keys in instance-worker.ts. Typed loosely — Proxy forwards args.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: `sessions${string}`]: (...args: any[]) => Promise<any>;
};

/** POST /api/instances/:id/sessions — create a new session.
 *
 * Body: { sessionId?, rootKind?, title? }
 * Returns 201 with the resolved sessionId + the SessionRuntime meta.
 */
export async function handleSessionCreate(
  ctx: GatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  instId: string,
): Promise<void> {
  const inst = ctx.getInstance(instId) as WorkerRpcHandle | undefined;
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  const body = await parseJsonBody<CreateSessionBody>(req);
  try {
    const runtime = await inst.sessions.create({
      sessionId: body.sessionId,
      rootKind: body.rootKind,
      title: body.title,
    });
    json(res, 201, { session: runtime.meta });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
}

/** GET /api/instances/:id/sessions — list all SessionRuntime metas. */
export async function handleSessionList(
  ctx: GatewayContext,
  res: ServerResponse,
  instId: string,
): Promise<void> {
  const inst = ctx.getInstance(instId) as WorkerRpcHandle | undefined;
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  try {
    const sessions = await inst.sessionsList();
    json(res, 200, { sessions });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}

/** POST /api/instances/:id/sessions/:sid/emit — publish an event to the
 *  SessionRuntime's bus. Mirrors handleInstanceEmit but session-scoped. */
export async function handleSessionEmit(
  ctx: GatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  instId: string,
  sid: string,
): Promise<void> {
  const body = await parseJsonBody<{ event?: Partial<Event> }>(req);
  if (!body.event || !body.event.type) {
    json(res, 400, { error: "Missing event or event.type" }); return;
  }
  const inst = ctx.getInstance(instId) as WorkerRpcHandle | undefined;
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  const event = {
    source: body.event.source ?? "external",
    type: body.event.type,
    payload: body.event.payload ?? {},
    ts: body.event.ts ?? Date.now(),
    to: body.event.to,
    handoff: body.event.handoff,
  } as Event;
  try {
    await inst.sessionsEmit(sid, event);
    json(res, 202, { accepted: true, sessionId: sid });
  } catch (e) {
    const msg = (e as Error).message;
    if (/not found/i.test(msg)) {
      json(res, 404, { error: msg });
    } else {
      json(res, 500, { error: msg });
    }
  }
}

/** DELETE /api/instances/:id/sessions/:sid — dispose the SessionRuntime
 *  (shutdown agent tree + fsync ledgers). Query `?archive=true` keeps the
 *  ledger directory on disk so it can be inspected later. */
export async function handleSessionDelete(
  ctx: GatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  instId: string,
  sid: string,
): Promise<void> {
  const inst = ctx.getInstance(instId) as WorkerRpcHandle | undefined;
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  const url = req.url ?? "";
  const archive = /\barchive=true\b/.test(url);
  try {
    await inst.sessionsDispose(sid, { archive });
    json(res, 200, { disposed: sid });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}
