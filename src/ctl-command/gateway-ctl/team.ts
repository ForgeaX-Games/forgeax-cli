/** @desc CLI — team management commands */

import { type ConnInfo, apiCall, print, die } from "./http.js";
import { bumpVersion } from "../../gateway/team/utils.js";

export async function cmdInstanceInfo(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance info <id>");
  const { data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(instId)}/team`);
  print(data);
}

export async function cmdInstanceLoad(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const packId = args[1];
  if (!instId || !packId) die("Usage: agenteam instance load <id> <packId> [--fork]");
  const fork = args.includes("--fork");
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/load`,
    { packId, ...(fork ? { fork: true } : {}) },
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceSave(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const name = args[1];
  if (!instId || !name) die("Usage: agenteam instance save <id> <name>");
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/save`,
    { name },
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceUpdate(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance update <id>");
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/update`,
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceRestore(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const backupName = args[1];
  if (!instId || !backupName) die("Usage: agenteam instance restore <id> <backupName>");
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/restore`,
    { backupName },
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceManifest(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance manifest <id>");
  const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(instId)}/team/manifest`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceManifestUpdate(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const jsonStr = args[1];
  if (!instId || !jsonStr) die("Usage: agenteam instance manifest-update <id> '<json>'");
  let body: Record<string, unknown>;
  try { body = JSON.parse(jsonStr); } catch { die("Invalid JSON: " + jsonStr); }
  const { status, data } = await apiCall(conn, "PUT", `/api/instances/${encodeURIComponent(instId)}/team/manifest`, body!);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceDeleteBackup(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const backupName = args[1];
  if (!instId || !backupName) die("Usage: agenteam instance delete-backup <id> <backupName>");
  const { status, data } = await apiCall(
    conn, "DELETE",
    `/api/instances/${encodeURIComponent(instId)}/team/backup`,
    { backupName },
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceRmContainers(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance rm-containers <id>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/instances/${encodeURIComponent(instId)}/team/containers`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceSyncPack(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const bump = args[1];
  if (!instId) die("Usage: agenteam instance sync-pack <id> [major|minor|patch]");

  const { status: ps, data: preview } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/sync-preview`,
  );
  if (ps >= 400) die(JSON.stringify(preview));

  const files = (preview as any).files ?? [];
  if (files.length === 0) {
    console.log("No changes to sync.");
    return;
  }

  console.log(`Pack: ${(preview as any).packId}  Current version: ${(preview as any).currentVersion}`);
  console.log("Changes:");
  for (const f of files) {
    const icon = f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~";
    console.log(`  ${icon} ${f.path}`);
  }

  const bumpType = (bump ?? "patch") as "major" | "minor" | "patch";
  const currentVersion = (preview as any).currentVersion ?? "1.0.0";
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`\nSyncing as v${newVersion} (${bumpType} bump)...`);

  const { status: ss, data: result } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/team/sync`,
    { newVersion },
  );
  if (ss >= 400) die(JSON.stringify(result));
  print(result);
}
