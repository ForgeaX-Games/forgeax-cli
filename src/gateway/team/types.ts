/** @desc Team types — manifest, update result, sync preview */

import type { PackJson } from "../../defaults/pack/pack-json.js";

/**
 * TeamManifest = pack.json fields (flat, same names) + team runtime fields.
 * Bidirectional mapping with PackJson is trivial: spread + strip runtime keys.
 */
export interface TeamManifest {
  // ── Pack fields (mirror pack.json, same names) ──
  id: string;
  version: string;
  description?: string;
  default_agent?: string;
  sandbox?: PackJson["sandbox"];

  // ── Team runtime fields ──
  teamId: string;
  sourceType: "pack" | "backup";
  createdAt: string;
  lastStartedAt: string;
}

export interface UpdateTeamResult {
  status: "updated" | "up_to_date" | "no_source";
  fromVersion?: string;
  toVersion?: string;
  packId?: string;
  message: string;
}

export interface SyncPreview {
  packId: string;
  currentVersion: string;
  files: { path: string; status: "added" | "modified" | "deleted" }[];
}

/** Extract pack.json-compatible object from a manifest (strip runtime fields). */
export function extractPackJson(manifest: TeamManifest): PackJson {
  const { teamId, sourceType, createdAt, lastStartedAt, ...packFields } = manifest;
  return packFields;
}

/** Build a fresh manifest from a pack.json. */
export function buildManifestFromPack(packJson: PackJson): TeamManifest {
  return {
    ...packJson,
    id: packJson.id,
    version: packJson.version || "1.0.0",
    teamId: `${packJson.id}_${Math.random().toString(36).substring(2, 10)}`,
    sourceType: "pack",
    createdAt: new Date().toISOString(),
    lastStartedAt: new Date().toISOString(),
  };
}
