// @desc Pack route handlers — list, install, create, build, remove
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import { json, parseJsonBody } from "./utils.js";

export async function handlePacksList(ctx: GatewayContext, res: ServerResponse): Promise<void> {
  const packs = await ctx.packRegistry.list();
  json(res, 200, { packs });
}

export async function handlePacksInstall(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ source?: string }>(req);
  if (!body.source) {
    json(res, 400, { error: "Missing 'source' field (URL or local path)" }); return;
  }
  const packId = await ctx.packRegistry.install(body.source);
  json(res, 200, { packId, installed: true });
}

export async function handlePacksCreate(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ id?: string; description?: string }>(req);
  if (!body.id) { json(res, 400, { error: "Missing 'id' field" }); return; }
  const packId = await ctx.packRegistry.create(body.id, {
    description: body.description,
  });
  json(res, 201, { packId, created: true });
}

export async function handlePacksBuild(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, packId: string): Promise<void> {
  const body = await parseJsonBody<{ instanceRoot?: string; force?: boolean }>(req);
  await ctx.packRegistry.build(packId, {
    instanceRoot: body.instanceRoot ?? process.cwd(),
    force: body.force ?? false,
  });
  json(res, 200, { packId, built: true });
}

export async function handlePacksFork(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ sourceId?: string; newId?: string }>(req);
  if (!body.sourceId || !body.newId) {
    json(res, 400, { error: "Missing 'sourceId' and/or 'newId'" }); return;
  }
  try {
    const newPackId = await ctx.packRegistry.fork(body.sourceId, body.newId);
    json(res, 200, { packId: newPackId, forked: true });
  } catch (e: any) {
    json(res, 400, { error: e.message ?? String(e) });
  }
}

export async function handlePacksRemove(ctx: GatewayContext, res: ServerResponse, packId: string): Promise<void> {
  try {
    await ctx.packRegistry.remove(packId);
    json(res, 200, { packId, removed: true });
  } catch (e: any) {
    json(res, e.message?.includes("not found") ? 404 : 500, { error: String(e) });
  }
}

export async function handlePacksCleanImage(ctx: GatewayContext, res: ServerResponse, packId: string): Promise<void> {
  try {
    const result = await ctx.packCleanImage(packId);
    json(res, 200, { packId, ...result });
  } catch (e: any) {
    json(res, e.message?.includes("not found") ? 404 : 500, { error: String(e) });
  }
}

export async function handlePacksPull(ctx: GatewayContext, res: ServerResponse, packId: string): Promise<void> {
  try {
    const result = await ctx.packRegistry.pull(packId);
    json(res, 200, result);
  } catch (e: any) {
    json(res, 400, { error: e.message ?? String(e) });
  }
}

export async function handlePacksPush(ctx: GatewayContext, res: ServerResponse, packId: string): Promise<void> {
  try {
    const result = await ctx.packRegistry.push(packId);
    json(res, 200, result);
  } catch (e: any) {
    json(res, 400, { error: e.message ?? String(e) });
  }
}
