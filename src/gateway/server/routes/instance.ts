// @desc Instance route handlers — lifecycle (list, add, detail, start, stop, restart, shutdown, free, sync, interrupt, ports)
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import { json, parseJsonBody } from "./utils.js";

export function handleInstancesList(ctx: GatewayContext, res: ServerResponse): void {
  const instances = ctx.listInstances().map(inst => ({
    ...inst,
    portMappings: ctx.getPortMappings(inst.id),
  }));
  json(res, 200, { instances });
}

export function handleInstanceDetail(ctx: GatewayContext, res: ServerResponse, instId: string): void {
  const inst = ctx.getInstance(instId);
  const listEntry = ctx.listInstances().find(i => i.id === instId);
  if (!inst && !listEntry) { json(res, 404, { error: `Instance "${instId}" not found` }); return; }
  json(res, 200, {
    id: instId,
    status: inst?.status ?? listEntry?.status ?? "unloaded",
    statusMessage: listEntry?.statusMessage,
    provisioningPhase: listEntry?.provisioningPhase,
    instanceDir: inst?.instanceDir ?? "",
    portMappings: ctx.getPortMappings(instId),
    autoStart: listEntry?.autoStart ?? true,
    createdAt: listEntry?.createdAt ?? "",
  });
}

export async function handleInstanceAdd(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ id?: string }>(req);
  if (!body.id) { json(res, 400, { error: "Missing 'id'" }); return; }
  const inst = await ctx.addInstance(body.id);
  json(res, 201, { id: inst.id, status: inst.status });
}

export async function handleInstanceStart(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  await ctx.startInstance(instId);
  json(res, 202, { id: instId, status: "starting" });
}

export async function handleInstanceStop(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  await ctx.stopInstance(instId);
  json(res, 200, { id: instId, stopped: true });
}

export async function handleInstanceRestart(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  await ctx.restartInstance(instId);
  json(res, 200, { id: instId, restarted: true });
}

export async function handleInstanceFree(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  await ctx.freeInstance(instId);
  json(res, 202, { id: instId, freed: true });
}

export async function handleInstanceShutdown(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  await ctx.shutdownInstance(instId);
  json(res, 200, { id: instId, shutdown: true });
}

export async function handleInstanceSync(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  const result = await ctx.syncInstance(instId);
  json(res, 200, { id: instId, ...result });
}

export function handleInstanceInterrupt(ctx: GatewayContext, res: ServerResponse, instId: string, query?: URLSearchParams): void {
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded, start it first` }); return; }
  const agentId = query?.get("agent") ?? undefined;
  inst.interruptAgents(agentId);
  json(res, 200, { id: instId, interrupted: true, ...(agentId ? { agent: agentId } : {}) });
}

export function handleInstancePorts(ctx: GatewayContext, res: ServerResponse, instId: string): void {
  const mappings = ctx.getPortMappings(instId);
  json(res, 200, { instanceId: instId, portMappings: mappings });
}
