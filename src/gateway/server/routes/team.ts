// @desc Team route handlers — load, save, restore, manifest, containers
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../../types.js";
import { json, parseJsonBody } from "./utils.js";

export async function handleTeamInfo(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  try {
    const r = await inst.commandQuery("fetch_team_info", []);
    if (!r.ok) { json(res, 500, { error: r.error }); return; }
    json(res, 200, r.data);
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

export async function handleTeamLoad(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ packId?: string; forkId?: string }>(req);
  if (!body.packId) { json(res, 400, { error: "Missing 'packId'" }); return; }
  await ctx.teamLoad(instId, body.packId, body.forkId ? { forkId: body.forkId } : undefined);
  json(res, 200, { loaded: true, packId: body.packId, forked: !!body.forkId });
}

export async function handleTeamSave(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ name?: string }>(req);
  if (!body.name) { json(res, 400, { error: "Missing 'name'" }); return; }
  await ctx.teamSave(instId, body.name);
  json(res, 200, { saved: true, name: body.name });
}

export async function handleTeamRestore(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ backupName?: string }>(req);
  if (!body.backupName) { json(res, 400, { error: "Missing 'backupName'" }); return; }
  await ctx.teamRestore(instId, body.backupName);
  json(res, 200, { restored: true, backupName: body.backupName });
}

export async function handleTeamManifest(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  const inst = ctx.getInstance(instId);
  if (!inst) { json(res, 409, { error: `Instance "${instId}" not loaded` }); return; }
  try {
    const r = await inst.commandQuery("fetch_team_manifest", []);
    if (!r.ok) { json(res, 500, { error: r.error }); return; }
    if (!r.data) { json(res, 404, { error: "No manifest found" }); return; }
    json(res, 200, r.data);
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

export async function handleTeamManifestUpdate(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody(req);
  await ctx.teamUpdateManifest(instId, body);
  json(res, 200, { updated: true });
}

export async function handleTeamUpdate(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  const result = await ctx.teamUpdate(instId);
  const status = result.status === "no_source" ? 400 : 200;
  json(res, status, result);
}

export async function handleTeamDeleteBackup(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ backupName?: string }>(req);
  if (!body.backupName) { json(res, 400, { error: "Missing 'backupName'" }); return; }
  try {
    await ctx.teamDeleteBackup(instId, body.backupName);
    json(res, 200, { deleted: true, backupName: body.backupName });
  } catch (err: any) {
    json(res, 404, { error: err.message ?? String(err) });
  }
}

export async function handleTeamRemoveContainers(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  const result = await ctx.teamRemoveContainers(instId);
  json(res, 200, result);
}

export async function handleTeamSyncPreview(ctx: GatewayContext, res: ServerResponse, instId: string): Promise<void> {
  try {
    const preview = await ctx.teamSyncPreview(instId);
    json(res, 200, preview);
  } catch (err: any) {
    json(res, 400, { error: err.message ?? String(err) });
  }
}

export async function handleTeamSyncExecute(ctx: GatewayContext, req: IncomingMessage, res: ServerResponse, instId: string): Promise<void> {
  const body = await parseJsonBody<{ newVersion?: string }>(req);
  if (!body.newVersion) { json(res, 400, { error: "Missing 'newVersion'" }); return; }
  try {
    await ctx.teamSyncExecute(instId, body.newVersion);
    json(res, 200, { synced: true, version: body.newVersion });
  } catch (err: any) {
    json(res, 400, { error: err.message ?? String(err) });
  }
}
