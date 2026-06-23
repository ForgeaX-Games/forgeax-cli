/** @desc CLI — pack management commands */

import { type ConnInfo, apiCall, print, die, extractFlag } from "./http.js";

export async function cmdPacks(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/api/packs");
  print(data);
}

export async function cmdPackAdd(conn: ConnInfo, args: string[]): Promise<void> {
  const source = args[0];
  if (!source) die("Usage: agenteam pack add <source>");
  const { status, data } = await apiCall(conn, "POST", "/api/packs/install", { source });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackBuild(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack build <id> [--force]");
  const force = args.includes("--force");
  const { status, data } = await apiCall(conn, "POST", `/api/packs/${encodeURIComponent(id)}/build`, { force });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackCreate(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack create <id> [--template <basic|platform>]");
  const template = extractFlag(args, "--template");
  const { status, data } = await apiCall(conn, "POST", "/api/packs/create", { id, template });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackRemove(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack remove <id>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/packs/${encodeURIComponent(id)}`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackCleanImage(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack clean-image <id>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/packs/${encodeURIComponent(id)}/image`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackFork(conn: ConnInfo, args: string[]): Promise<void> {
  const sourceId = args[0];
  const newId = args[1];
  if (!sourceId || !newId) die("Usage: agenteam pack fork <sourceId> <newId>");
  const { status, data } = await apiCall(conn, "POST", "/api/packs/fork", { sourceId, newId });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackPull(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack pull <forkId>");
  const { status, data } = await apiCall(conn, "POST", `/api/packs/${encodeURIComponent(id)}/pull`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdPackPush(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam pack push <forkId>");
  const { status, data } = await apiCall(conn, "POST", `/api/packs/${encodeURIComponent(id)}/push`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}
