/** @desc Team scaffold — ensure team runtime directories and template files */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPathManager } from "../fs/path-manager.js";
import { ensureAgentTemplateFiles, STANDARD_DEFINITION_DIRS } from "./agent-scaffold.js";
import { defaultBaseEnvTemplate } from "../defaults/pack/base-env.js";

/**
 * Files/dirs that exist in a pack template but should NOT be carried
 * into an active team directory. They are either replaced (pack.json → manifest.json)
 * or are build artifacts irrelevant at runtime.
 */
const PACK_ONLY_FILES = [
  "pack.json",      // replaced by manifest.json
  "image.tar",      // Docker image archive (can be hundreds of MB)
  ".built",         // build marker
];

/**
 * Remove pack-only files from a team directory after pack-to-team copy.
 * Safe to call even if the files don't exist (idempotent).
 */
export async function stripPackOnlyFiles(teamRoot: string): Promise<void> {
  for (const name of PACK_ONLY_FILES) {
    const p = join(teamRoot, name);
    if (existsSync(p)) {
      await rm(p, { force: true });
    }
  }
}

/**
 * Ensure team-level runtime directories exist (idempotent).
 * Framework-native dirs: shared-workspace, capabilities, templates.
 * (logs/ and terminals/ are created by Logger and TerminalManager respectively.
 *  skills/ is capability-owned, not created here.
 *  medias/ lives under sessions/{agentId}/{sessionId}/ — created by EventLedger on demand.)
 */
export async function ensureTeamDirs(): Promise<void> {
  const pm = getPathManager();
  await mkdir(pm.team().sharedWorkspace(), { recursive: true });
  for (const dir of STANDARD_DEFINITION_DIRS) await mkdir(join(pm.team().root(), dir), { recursive: true });
}

/**
 * Ensure team/env/base.env exists (idempotent — skips if already present).
 * Called during team init and pack load.
 */
export async function ensureTeamBaseEnv(): Promise<void> {
  const pm = getPathManager();
  const envDir = pm.team().envDir();
  const baseEnvPath = join(envDir, "base.env");

  if (existsSync(baseEnvPath)) return;

  await mkdir(envDir, { recursive: true });
  await writeFile(baseEnvPath, defaultBaseEnvTemplate(), "utf-8");
}

/**
 * Seed mounts.json from pack manifest if it doesn't exist yet.
 * Moved here from gateway/team/scaffold.ts — this is sandbox configuration
 * and belongs in the worker-side init flow (called before SandboxManager.init).
 */
export async function ensureMountsConfig(): Promise<void> {
  const pm = getPathManager();
  const mountsPath = pm.instance().mountsConfig();
  if (existsSync(mountsPath)) return;

  const manifestPath = pm.team().manifest();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    const packMounts = manifest.sandbox?.mounts ?? [];
    const template = {
      _comment: "Add mounts here. Each entry needs name, host_path, container_path. Pack-declared mounts are pre-filled as a starting point.",
      mounts: packMounts.map((m: any) => ({
        name: m.name,
        host_path: "",
        container_path: m.path,
        writable: m.writable ?? true,
        ...(m.description ? { description: m.description } : {}),
        ...(m.optional ? { optional: true } : {}),
      })),
    };
    await writeFile(mountsPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
    console.log(`[TeamScaffold] Generated mounts.json at ${mountsPath}`);
  } catch {
    // manifest unreadable — skip mounts seeding
  }
}

/**
 * Walk team/agents/ and ensure every agent directory has the full
 * template skeleton (agent.json, SOUL.md, PRINCIPLE.md, homes/, sessions/, etc.).
 * Idempotent — existing files are never overwritten.
 */
export async function ensureTeamAgentsFilesystem(): Promise<void> {
  const pm = getPathManager();
  const agentsDir = pm.team().agentsDir();
  if (!existsSync(agentsDir)) return;

  const entries = await readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await ensureAgentTemplateFiles(entry.name);
  }
}
