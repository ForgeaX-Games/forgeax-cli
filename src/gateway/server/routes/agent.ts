// @desc Agent route — emit events (instance-level)
//
// list_agents / free_agent moved to the commands system (via WS frames or
// `/api/instances/:id/commands/{list_agents|free_agent}/{query|execute}`).
// Only the instance-level `emit` endpoint remains here.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import type { Event } from "../../../core/types.js";
import { json, parseJsonBody } from "./utils.js";

/** POST /api/instances/:id/emit — publish an arbitrary event to the instance EventBus. */
export async function handleInstanceEmit(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ event?: Partial<Event> }>(req);
  if (!body.event || !body.event.type) {
    json(res, 400, { error: "Missing event or event.type" }); return;
  }
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded, start it first` }); return; }
  if (inst.status !== "running") {
    json(res, 503, { error: `Instance is ${inst.status}, not running` }); return;
  }
  const event = {
    source: body.event.source ?? "external",
    type: body.event.type,
    payload: body.event.payload ?? {},
    ts: body.event.ts ?? Date.now(),
    to: body.event.to,
    handoff: body.event.handoff,
  } as Event;
  inst.emit(event);
  json(res, 202, { accepted: true });
}
