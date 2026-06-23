// @desc Commands HTTP transport — list / query / execute via gateway
//
// Three endpoints replace the 9 separate agent-level HTTP routes that used to
// hang on gateway (tree / teamboard / agent-json / agent-overrides / sessions /
// agents / etc). Gateway is now back to "only manages instance level" — all
// agent-level business goes through commands system, accessed via either WS
// frames (long-lived clients like ink-renderer) or these HTTP endpoints
// (one-shot clients like UI / gateway-ctl / wechat).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import { json, parseJsonBody } from "./utils.js";

/** GET /api/instances/:id/commands[?agent=X] — list available commands */
export async function handleCommandsList(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  const qs = (req.url ?? "").split("?")[1] ?? "";
  const requestingAgentId = new URLSearchParams(qs).get("agent") || undefined;
  try {
    const { commands } = await inst.listCommands(requestingAgentId);
    json(res, 200, { commands });
  } catch (err) {
    json(res, 500, { error: (err as Error)?.message ?? String(err) });
  }
}

/**
 * POST /api/instances/:id/commands/:name/query    body { args?, requestingAgentId? }
 * POST /api/instances/:id/commands/:name/execute  body { args?, requestingAgentId? }
 * Response: { result: CommandResult }
 */
async function callCommand(
  kind: "query" | "execute",
  ctx: GatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  instId: string,
  name: string,
): Promise<void> {
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  let body: { args?: Record<string, unknown>; requestingAgentId?: string } = {};
  try { body = await parseJsonBody(req); } catch { /* empty body acceptable for parameterless commands */ }
  try {
    const args = Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [];
    const result = kind === "query"
      ? await inst.commandQuery(name, args, { requestingAgentId: body.requestingAgentId })
      : await inst.commandExecute(name, args, { requestingAgentId: body.requestingAgentId });
    json(res, result.ok ? 200 : 500, { result });
  } catch (err) {
    json(res, 500, { error: (err as Error)?.message ?? String(err) });
  }
}

export const handleCommandQuery   = (ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string, name: string): Promise<void> => callCommand("query",   ctx, req, res, instId, name);
export const handleCommandExecute = (ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string, name: string): Promise<void> => callCommand("execute", ctx, req, res, instId, name);
