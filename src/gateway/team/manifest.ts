/** @desc Manifest read/write/info helpers */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamInfoPayload } from "../../core/types.js";
import type { TeamManifest } from "./types.js";

export function readManifestRaw(instanceDir: string): Record<string, unknown> | null {
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { return null; }
}

export function readManifest(instanceDir: string): TeamManifest | null {
  const raw = readManifestRaw(instanceDir);
  return raw as TeamManifest | null;
}

export async function updateManifest(instanceDir: string, patch: Record<string, unknown>): Promise<void> {
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("No manifest.json found");
  const current = JSON.parse(await readFile(manifestPath, "utf-8"));
  const updated = { ...current, ...patch };
  await writeFile(manifestPath, JSON.stringify(updated, null, 2), "utf-8");
}

export function teamInfo(instanceDir: string): { team: TeamInfoPayload | null; backups: string[] } {
  let team: TeamInfoPayload | null = null;
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw: TeamManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      team = {
        teamId: raw.teamId,
        source: { type: raw.sourceType, id: raw.id, version: raw.version },
        ...(raw.default_agent ? { defaultAgent: raw.default_agent } : {}),
        createdAt: raw.createdAt,
      };
    } catch {}
  }

  const backups: string[] = [];
  const backupsDir = join(instanceDir, "backups");
  if (existsSync(backupsDir)) {
    for (const f of readdirSync(backupsDir)) {
      if (f.endsWith(".zip")) backups.push(f.replace(/\.zip$/, ""));
    }
  }

  return { team, backups };
}
