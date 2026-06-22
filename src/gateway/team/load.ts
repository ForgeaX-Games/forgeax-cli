/** @desc loadPack — copy pack into team, generate manifest */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripPackOnlyFiles } from "../../team/team-scaffold.js";
import { spawnAsync, readPackJson } from "./utils.js";
import { buildManifestFromPack } from "./types.js";
import { saveBackup } from "./backup.js";
import { listPackEntries, generateIncludePack } from "./include-pack.js";

async function autoBackup(instanceDir: string): Promise<void> {
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    if (manifest.teamId) {
      console.log(`[TeamOps] Auto-backing up current team: ${manifest.teamId}`);
      await saveBackup(instanceDir, manifest.teamId);
    }
  } catch (err) {
    console.warn("[TeamOps] Failed to auto-backup current team:", err);
  }
}

export async function loadPack(instanceDir: string, packId: string, packsDir: string): Promise<void> {
  const teamRoot = join(instanceDir, "team");
  const packDir = join(packsDir, packId);

  if (!existsSync(packDir)) throw new Error(`Pack "${packId}" not found in ${packsDir}`);

  const packJson = readPackJson(packDir);

  if (existsSync(teamRoot)) {
    await autoBackup(instanceDir);
    await rm(teamRoot, { recursive: true, force: true });
  }
  await mkdir(teamRoot, { recursive: true });

  await spawnAsync("rsync", ["-a", "--exclude", ".git", `${packDir}/`, `${teamRoot}/`]);
  await stripPackOnlyFiles(teamRoot);

  const manifest = buildManifestFromPack(packJson);
  await writeFile(join(teamRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const entries = await listPackEntries(packDir);
  await writeFile(join(teamRoot, ".include-pack"), generateIncludePack(entries), "utf-8");
  // Directory scaffold deferred to startInstance() — the caller (teamLoad)
  // always follows with addInstance → startInstance which runs ensureTeamDirs in the worker.
}
