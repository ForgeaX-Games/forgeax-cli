/** @desc updateTeam — pull newer pack version into team */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripPackOnlyFiles } from "../../team/team-scaffold.js";
import { spawnAsync, readPackJson } from "./utils.js";
import type { TeamManifest, UpdateTeamResult } from "./types.js";
import { listPackEntries, generateIncludePack, readUserSection } from "./include-pack.js";
import { gitEnsure, gitCommitAndTag } from "../packs/pack-git.js";

export async function updateTeam(instanceDir: string, packsDir: string): Promise<UpdateTeamResult> {
  const teamRoot = join(instanceDir, "team");
  const manifestPath = join(teamRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { status: "no_source", message: "No manifest.json found — team not loaded from a pack." };
  }

  const manifest: TeamManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (manifest.sourceType !== "pack" || !manifest.id) {
    return { status: "no_source", message: "Team was not loaded from a pack — cannot update." };
  }

  const packId = manifest.id;
  const packDir = join(packsDir, packId);
  if (!existsSync(packDir)) {
    return { status: "no_source", message: `Source pack "${packId}" not found in ${packsDir}.` };
  }

  const packJson = readPackJson(packDir);
  const packVersion = packJson.version || "1.0.0";
  const teamVersion = manifest.version;

  if (packVersion === teamVersion) {
    return { status: "up_to_date", packId, fromVersion: teamVersion, toVersion: packVersion, message: `Already up to date (v${teamVersion}).` };
  }

  // Version changed → commit pack git before syncing to team
  await gitEnsure(packDir, packId, packVersion);
  await gitCommitAndTag(packDir, packVersion).catch((err) => {
    console.warn(`[TeamUpdate] git commit/tag for pack '${packId}' failed (non-fatal):`, err);
  });

  const userSection = await readUserSection(teamRoot);

  await spawnAsync("rsync", ["-a", "--exclude", ".git", `${packDir}/`, `${teamRoot}/`]);
  await stripPackOnlyFiles(teamRoot);

  const entries = await listPackEntries(packDir);
  await writeFile(join(teamRoot, ".include-pack"), generateIncludePack(entries, userSection), "utf-8");

  manifest.version = packVersion;
  if (packJson.sandbox) manifest.sandbox = packJson.sandbox;
  if (packJson.default_agent) manifest.default_agent = packJson.default_agent;
  if (packJson.description !== undefined) manifest.description = packJson.description;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  // Directory scaffold not needed here — updateTeam is a hot file sync (pack→team)
  // that doesn't affect directory structure. ensureTeamDirs runs on startInstance().

  return { status: "updated", packId, fromVersion: teamVersion, toVersion: packVersion, message: `Updated from v${teamVersion} → v${packVersion}.` };
}
