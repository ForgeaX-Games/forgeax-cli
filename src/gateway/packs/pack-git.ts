/** @desc Git operations for pack version management */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "inherit", "inherit"], cwd });
    child.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`git ${args[0]} failed (exit ${code})`)); });
    child.on("error", reject);
  });
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; });
    child.on("close", (code) => { if (code === 0) resolve(out.trim()); else reject(new Error(`git ${args[0]} failed (exit ${code})`)); });
    child.on("error", reject);
  });
}

async function ensureLocalIdentity(packDir: string): Promise<void> {
  try { await gitOutput(["config", "user.name"], packDir); } catch {
    await git(["config", "user.name", "AgenTeam Pack"], packDir);
    await git(["config", "user.email", "pack@agenteam.local"], packDir);
  }
}

/** Initialize a pack directory as a git repo with initial commit + version tag. */
export async function gitInit(packDir: string, packId: string, version: string): Promise<void> {
  if (existsSync(join(packDir, ".git"))) return;
  await git(["init"], packDir);
  await ensureLocalIdentity(packDir);
  await git(["add", "."], packDir);
  await git(["commit", "-m", `init: ${packId} v${version}`], packDir);
  await git(["tag", `v${version}`], packDir);
}

/** Ensure a pack has a git repo; if not, initialize one. */
export async function gitEnsure(packDir: string, packId: string, version: string): Promise<void> {
  if (!existsSync(join(packDir, ".git"))) {
    await gitInit(packDir, packId, version);
  }
}

/** Commit all changes and tag with version (force-replaces existing tag). */
export async function gitCommitAndTag(packDir: string, version: string, message?: string): Promise<void> {
  await ensureLocalIdentity(packDir);
  await git(["add", "."], packDir);
  const msg = message ?? `v${version}`;
  await git(["commit", "-m", msg, "--allow-empty"], packDir);
  await git(["tag", "-f", `v${version}`], packDir);
}

/** Clone a pack repo as a fork, rename origin to "source". */
export async function gitFork(sourceDir: string, destDir: string): Promise<void> {
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await git(["clone", "--no-hardlinks", sourceDir, destDir], sourceDir);
  await git(["remote", "rename", "origin", "source"], destDir);
}

/** Get the current HEAD short hash (for diagnostics). */
export async function gitHead(packDir: string): Promise<string> {
  return gitOutput(["rev-parse", "--short", "HEAD"], packDir);
}

/** Check if pack has a "source" remote (i.e. is a fork). */
export async function hasSourceRemote(packDir: string): Promise<boolean> {
  try {
    await gitOutput(["remote", "get-url", "source"], packDir);
    return true;
  } catch {
    return false;
  }
}

/** Fetch + merge from the "source" remote (for forked packs). */
export async function gitPullFromSource(packDir: string): Promise<string> {
  await git(["fetch", "source"], packDir);
  const branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], packDir);
  await git(["merge", `source/${branch}`, "--no-edit"], packDir);
  return branch;
}

/** Push to the "source" remote (for forked packs). */
export async function gitPushToSource(packDir: string): Promise<string> {
  const branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], packDir);
  await git(["push", "source", `HEAD:${branch}`], packDir);
  return branch;
}
