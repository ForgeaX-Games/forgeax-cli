/** @desc team→pack sync — preview changes and execute sync-back */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, writeFile, cp, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { TeamManifest, SyncPreview } from "./types.js";
import { extractPackJson } from "./types.js";
import { parseIncludePack } from "./include-pack.js";
import { parsePatterns, isIncluded, type ParsedPattern } from "./pattern-matcher.js";

/** Framework-shipped negatives. Injected after autoEntries so `!agents/subagent_*`
 *  isn't re-included by a later `agents/` positive. userLines are parsed last
 *  (last-match-wins → users can override). Also a fallback for older instances
 *  whose .include-pack file pre-dates this feature. */
const BUILTIN_NEGATIONS: string[] = [
  "!agents/subagent_*",
];

const TEAM_ONLY_FILES = new Set(["manifest.json", ".include-pack"]);

/** Recursively remove empty directories (bottom-up). Skips .git. Never removes packRoot itself. */
async function removeEmptyDirs(packRoot: string): Promise<void> {
  async function walk(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true });
    let hasContent = false;
    for (const e of entries) {
      if (e.name === ".git") { hasContent = true; continue; }
      if (e.isDirectory()) {
        const childHasContent = await walk(join(dir, e.name));
        if (childHasContent) hasContent = true;
      } else {
        hasContent = true;
      }
    }
    if (!hasContent && dir !== packRoot) {
      await rm(dir, { recursive: true, force: true });
    }
    return hasContent;
  }
  await walk(packRoot);
}

/** Recursively list all files under a directory, returning relative paths. */
async function walkDir(dir: string, base = ""): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".git") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      results.push(...await walkDir(join(dir, e.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function fileContentEqual(pathA: string, pathB: string): boolean {
  try {
    const a = readFileSync(pathA);
    const b = readFileSync(pathB);
    return a.equals(b);
  } catch {
    return false;
  }
}

async function resolvePatterns(teamRoot: string): Promise<ParsedPattern[]> {
  const includePackPath = join(teamRoot, ".include-pack");
  if (!existsSync(includePackPath)) return [];
  const content = await readFile(includePackPath, "utf-8");
  const { autoEntries, userSection } = parseIncludePack(content);
  const userLines = userSection.split("\n");
  return parsePatterns([
    ...autoEntries,
    ...BUILTIN_NEGATIONS,
    ...userLines,
  ]);
}

export async function previewSync(instanceDir: string, packsDir: string): Promise<SyncPreview> {
  const teamRoot = join(instanceDir, "team");
  const manifestPath = join(teamRoot, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("No manifest.json found");

  const manifest: TeamManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (manifest.sourceType !== "pack" || !manifest.id) {
    throw new Error("Team not loaded from a pack");
  }

  const packDir = join(packsDir, manifest.id);
  if (!existsSync(packDir)) throw new Error(`Source pack "${manifest.id}" not found`);

  const patterns = await resolvePatterns(teamRoot);

  const files: SyncPreview["files"] = [];

  const teamFiles = await walkDir(teamRoot);
  const packFiles = await walkDir(packDir);
  const packFileSet = new Set(packFiles);

  for (const f of teamFiles) {
    if (TEAM_ONLY_FILES.has(f)) continue;
    if (!isIncluded(f, patterns)) continue;

    const teamPath = join(teamRoot, f);
    const packPath = join(packDir, f);

    if (!packFileSet.has(f)) {
      files.push({ path: f, status: "added" });
    } else if (!fileContentEqual(teamPath, packPath)) {
      files.push({ path: f, status: "modified" });
    }
    packFileSet.delete(f);
  }

  for (const f of packFileSet) {
    if (f === "pack.json" || f === "Dockerfile" || f === "image.tar" || f === ".built") continue;
    if (f.startsWith(".git/") || f === ".git") continue;

    // A pack file should be deleted when it's either:
    //   (a) inside the include set but missing from team (team deleted it), or
    //   (b) outside the include set entirely (user removed the path from .include-pack).
    // In both cases the file has no corresponding team source and must go.
    const inTeam = existsSync(join(teamRoot, f));
    const included = isIncluded(f, patterns);
    if (!inTeam || !included) {
      files.push({ path: f, status: "deleted" });
    }
  }

  return { packId: manifest.id, currentVersion: manifest.version, files };
}

// bumpVersion re-exported from utils for backward compatibility
export { bumpVersion } from "./utils.js";

export async function executeSync(
  instanceDir: string,
  packsDir: string,
  newVersion: string,
): Promise<void> {
  const teamRoot = join(instanceDir, "team");
  const manifestPath = join(teamRoot, "manifest.json");
  const manifest: TeamManifest = JSON.parse(await readFile(manifestPath, "utf-8"));

  if (manifest.sourceType !== "pack" || !manifest.id) {
    throw new Error("Team not loaded from a pack");
  }

  const packDir = join(packsDir, manifest.id);
  if (!existsSync(packDir)) throw new Error(`Source pack "${manifest.id}" not found`);

  // 1. Write pack.json with new version (manifest.version updated by poller after git commit)
  const packJson = extractPackJson(manifest);
  packJson.version = newVersion;
  await writeFile(join(packDir, "pack.json"), JSON.stringify(packJson, null, 2) + "\n", "utf-8");

  // 2. Copy included files from team to pack
  const patterns = await resolvePatterns(teamRoot);

  const teamFiles = await walkDir(teamRoot);
  for (const f of teamFiles) {
    if (TEAM_ONLY_FILES.has(f)) continue;
    if (!isIncluded(f, patterns)) continue;

    const src = join(teamRoot, f);
    const dest = join(packDir, f);
    if (statSync(src).isFile()) {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
    }
  }

  // 3. Delete pack files not backed by team: either removed from team or
  //    de-listed from .include-pack (user no longer wants them in pack).
  const teamFileSet = new Set(teamFiles);
  const packFiles = await walkDir(packDir);
  for (const f of packFiles) {
    if (f === "pack.json" || f === "Dockerfile" || f === "image.tar" || f === ".built") continue;
    if (!teamFileSet.has(f) || !isIncluded(f, patterns)) {
      await rm(join(packDir, f), { force: true });
    }
  }

  // 4. Remove empty directories left behind after file deletions
  await removeEmptyDirs(packDir);

  // Git commit deferred — next poller cycle detects version change and commits.
}
