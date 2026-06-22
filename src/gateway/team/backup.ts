/** @desc Team backup — save, restore, delete */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnAsync } from "./utils.js";

export async function saveBackup(instanceDir: string, name: string): Promise<void> {
  const teamRoot = join(instanceDir, "team");
  const manifestPath = join(teamRoot, "manifest.json");
  if (!existsSync(teamRoot) || !existsSync(manifestPath)) {
    console.warn("[TeamOps] No active team to backup.");
    return;
  }

  const backupsDir = join(instanceDir, "backups");
  await mkdir(backupsDir, { recursive: true });

  const backupPath = join(backupsDir, `${name}.zip`);
  try {
    await spawnAsync("zip", ["-r", backupPath, ".", "-x", "./terminals/*", "./logs/*/debug.log"], { cwd: teamRoot });
  } catch (err) {
    console.error("[TeamOps] Failed to zip team:", err);
  }
}

export async function deleteBackup(instanceDir: string, backupName: string): Promise<void> {
  const backupPath = join(instanceDir, "backups", `${backupName}.zip`);
  if (!existsSync(backupPath)) throw new Error(`Backup "${backupName}" not found`);
  await rm(backupPath, { force: true });
}

export async function restoreBackup(instanceDir: string, backupName: string): Promise<void> {
  const teamRoot = join(instanceDir, "team");
  const backupPath = join(instanceDir, "backups", `${backupName}.zip`);
  if (!existsSync(backupPath)) throw new Error(`Backup "${backupName}" not found`);

  if (existsSync(teamRoot)) {
    const manifestPath = join(teamRoot, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        if (manifest.teamId) {
          console.log(`[TeamOps] Auto-backing up current team: ${manifest.teamId}`);
          await saveBackup(instanceDir, manifest.teamId);
        }
      } catch {}
    }
    await rm(teamRoot, { recursive: true, force: true });
  }
  await mkdir(teamRoot, { recursive: true });

  await spawnAsync("unzip", [backupPath, "-d", teamRoot]);
  // Directory scaffold deferred to startInstance() — the caller (teamRestore)
  // always follows with addInstance → startInstance which runs ensureTeamDirs in the worker.
}
