/** @desc PackRegistry — Gateway-level pack listing, building, and remote installation */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, rename, rm, cp } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnAsync } from "../team/utils.js";
import {
  isPackBuilt as checkPackBuilt,
  buildPackDocker,
  buildPackDirect,
} from "../../packs/pack-builder.js";
import { createPackScaffold, type CreatePackOptions } from "./pack-scaffold.js";
import { gitInit, gitEnsure, gitFork, gitCommitAndTag, hasSourceRemote, gitPullFromSource, gitPushToSource } from "./pack-git.js";
import type { PackJson, SandboxMode } from "../../defaults/pack/pack-json.js";

export interface PackMeta {
  id: string;
  version?: string;
  description?: string;
  hasDockerfile: boolean;
  isBuilt: boolean;
}

export class PackRegistry {
  constructor(private readonly packsDir: string) {}

  // ── Query ──────────────────────────────────────────────────────────────────

  async list(): Promise<PackMeta[]> {
    if (!existsSync(this.packsDir)) return [];

    const entries = await readdir(this.packsDir, { withFileTypes: true });
    const results: PackMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.get(entry.name);
      if (meta) results.push(meta);
    }

    return results;
  }

  async get(packId: string): Promise<PackMeta | undefined> {
    const dir = this.resolveDir(packId);
    const packJsonPath = join(dir, "pack.json");
    if (!existsSync(packJsonPath)) return undefined;

    let packJson: PackJson;
    try {
      packJson = JSON.parse(await readFile(packJsonPath, "utf-8"));
    } catch {
      return undefined;
    }

    const hasDockerfile = existsSync(join(dir, "Dockerfile"));

    let isBuilt = false;
    try {
      isBuilt = existsSync(join(dir, ".built")) || existsSync(join(dir, "image.tar"));
    } catch { /* ignore */ }

    return {
      id: packJson.id ?? packId,
      version: packJson.version,
      description: packJson.description,
      hasDockerfile,
      isBuilt,
    };
  }

  resolveDir(packId: string): string {
    return join(this.packsDir, packId);
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Scaffold a new pack with a default steward agent, empty setup.sh, etc.
   * Generates: pack.json, agents/steward/{agent.json, SOUL.md, PRINCIPLE.md},
   *            startup-scripts/setup.sh, capabilities/ (empty).
   */
  async create(packId: string, opts?: CreatePackOptions): Promise<string> {
    await mkdir(this.packsDir, { recursive: true });
    const packDir = this.resolveDir(packId);
    await createPackScaffold(packDir, packId, opts);
    await gitInit(packDir, packId, "1.0.0").catch((err) => {
      console.warn(`[PackRegistry] git init failed for '${packId}' (non-fatal):`, err);
    });
    console.log(`[PackRegistry] Created pack '${packId}'`);
    return packId;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  async isBuilt(packId: string, mode: SandboxMode): Promise<boolean> {
    const dir = this.resolveDir(packId);
    return checkPackBuilt(dir, packId, mode !== "direct");
  }

  async build(
    packId: string,
    opts: { instanceRoot: string; force?: boolean },
  ): Promise<void> {
    const dir = this.resolveDir(packId);
    if (!existsSync(join(dir, "pack.json"))) {
      throw new Error(`Pack '${packId}' not found in ${this.packsDir}`);
    }

    const packJsonRaw: PackJson = JSON.parse(await readFile(join(dir, "pack.json"), "utf-8"));
    const mode: SandboxMode = packJsonRaw?.sandbox?.mode || "headless";

    if (!opts.force && (await this.isBuilt(packId, mode))) {
      console.log(`[PackRegistry] Pack '${packId}' already built, skipping (use force to rebuild)`);
      return;
    }

    if (mode === "direct") {
      await buildPackDirect(dir);
    } else {
      await buildPackDocker(dir, packId, opts.instanceRoot, mode);
    }
  }

  // ── Clean Image ────────────────────────────────────────────────────────────

  async cleanImage(packId: string): Promise<{ imageRemoved: boolean; tarRemoved: boolean; cacheCleared: boolean }> {
    const dir = this.resolveDir(packId);
    if (!existsSync(dir)) throw new Error(`Pack '${packId}' not found`);

    const imageTag = `mc-sbx-pack-${packId}`;
    let imageRemoved = false;
    let tarRemoved = false;
    let cacheCleared = false;

    // Remove Docker daemon images (tag + base tag)
    try {
      await spawnAsync("docker", ["rmi", "-f", imageTag]);
      imageRemoved = true;
    } catch {}
    await spawnAsync("docker", ["rmi", "-f", `${imageTag}-base`]).catch(() => {});

    // Remove image.tar
    const tarPath = join(dir, "image.tar");
    if (existsSync(tarPath)) {
      await rm(tarPath, { force: true });
      tarRemoved = true;
    }

    // Prune Docker build cache to prevent stale COPY layers from being reused
    try {
      await spawnAsync("docker", ["builder", "prune", "-f"]);
      cacheCleared = true;
    } catch {}

    console.log(`[PackRegistry] Cleaned image for '${packId}': docker=${imageRemoved}, tar=${tarRemoved}, cache=${cacheCleared}`);
    return { imageRemoved, tarRemoved, cacheCleared };
  }

  // ── Remove ─────────────────────────────────────────────────────────────────

  async remove(packId: string): Promise<void> {
    const dir = this.resolveDir(packId);
    if (!existsSync(dir)) throw new Error(`Pack '${packId}' not found`);

    const imageTag = `mc-sbx-pack-${packId}`;
    await spawnAsync("docker", ["rmi", "-f", imageTag]).catch(() => {});
    await spawnAsync("docker", ["rmi", "-f", `${imageTag}-base`]).catch(() => {});

    await rm(dir, { recursive: true, force: true });
    console.log(`[PackRegistry] Removed pack '${packId}'`);
  }

  // ── Git collaboration (pull/push between fork and source) ───────────────────

  async pull(packId: string): Promise<{ status: string; message: string }> {
    const dir = this.resolveDir(packId);
    if (!existsSync(dir)) throw new Error(`Pack '${packId}' not found`);
    if (!(await hasSourceRemote(dir))) {
      return { status: "no_source", message: `Pack '${packId}' has no source remote — not a fork.` };
    }
    const branch = await gitPullFromSource(dir);
    return { status: "ok", message: `Pulled from source (branch: ${branch})` };
  }

  async push(packId: string): Promise<{ status: string; message: string }> {
    const dir = this.resolveDir(packId);
    if (!existsSync(dir)) throw new Error(`Pack '${packId}' not found`);
    if (!(await hasSourceRemote(dir))) {
      return { status: "no_source", message: `Pack '${packId}' has no source remote — not a fork.` };
    }
    const branch = await gitPushToSource(dir);
    return { status: "ok", message: `Pushed to source (branch: ${branch})` };
  }

  // ── Fork ────────────────────────────────────────────────────────────────────

  /**
   * Fork a pack: git clone + update pack.json id + rename remote to "source".
   * Returns the new pack id.
   */
  async fork(sourcePackId: string, newPackId: string): Promise<string> {
    const sourceDir = this.resolveDir(sourcePackId);
    if (!existsSync(sourceDir)) throw new Error(`Source pack '${sourcePackId}' not found`);

    const destDir = this.resolveDir(newPackId);
    if (existsSync(destDir)) {
      const packJsonPath = join(destDir, "pack.json");
      if (existsSync(packJsonPath)) {
        try {
          const existing: PackJson = JSON.parse(await readFile(packJsonPath, "utf-8"));
          if (existing.id === newPackId) {
            throw new Error(`Pack '${newPackId}' already exists`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("already exists")) throw e;
        }
      }
      console.log(`[PackRegistry] Cleaning incomplete pack directory '${newPackId}' from previous attempt`);
    }

    await gitEnsure(sourceDir, sourcePackId, "1.0.0");
    await gitFork(sourceDir, destDir);

    // image.tar from source contains a tag for the source pack, not the fork
    const forkedTar = join(destDir, "image.tar");
    await rm(forkedTar, { force: true }).catch(() => {});

    const packJsonPath = join(destDir, "pack.json");
    const packJson: PackJson = JSON.parse(await readFile(packJsonPath, "utf-8"));
    packJson.id = newPackId;
    await writeFile(packJsonPath, JSON.stringify(packJson, null, 2) + "\n", "utf-8");

    await gitCommitAndTag(destDir, packJson.version || "1.0.0", `fork from ${sourcePackId}`).catch(() => {});

    console.log(`[PackRegistry] Forked '${sourcePackId}' → '${newPackId}'`);
    return newPackId;
  }

  // ── Install ────────────────────────────────────────────────────────────────

  /**
   * Install a pack from a URL (tar.gz / zip) or a local path.
   * Returns the installed packId (read from pack.json inside the archive).
   */
  async install(source: string): Promise<string> {
    await mkdir(this.packsDir, { recursive: true });

    if (source.startsWith("http://") || source.startsWith("https://")) {
      return this.installFromUrl(source);
    }

    if (isAbsolute(source) || source.startsWith("./") || source.startsWith("../")) {
      return this.installFromLocal(source);
    }

    throw new Error(`Invalid install source: ${source}. Provide a URL or local path.`);
  }

  private async installFromUrl(url: string): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), "pack-install-"));
    try {
      const archivePath = join(tmpDir, "archive");
      await this.download(url, archivePath);

      const extractDir = join(tmpDir, "extracted");
      await mkdir(extractDir, { recursive: true });

      if (url.endsWith(".zip")) {
        await spawnAsync("unzip", [archivePath, "-d", extractDir]);
      } else {
        await spawnAsync("tar", ["xzf", archivePath, "-C", extractDir]);
      }

      const packRoot = await this.findPackRoot(extractDir);
      return this.finalizeInstall(packRoot);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async installFromLocal(localPath: string): Promise<string> {
    if (!existsSync(localPath)) {
      throw new Error(`Local path not found: ${localPath}`);
    }

    const packJsonPath = join(localPath, "pack.json");
    if (!existsSync(packJsonPath)) {
      throw new Error(`No pack.json found at ${localPath}`);
    }

    const packJson: PackJson = JSON.parse(readFileSync(packJsonPath, "utf-8"));
    const packId = packJson.id;
    if (!packId) throw new Error("pack.json missing required 'id' field");

    const dest = this.resolveDir(packId);
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    await cp(localPath, dest, { recursive: true });

    await gitEnsure(dest, packId, packJson.version || "1.0.0").catch((err) => {
      console.warn(`[PackRegistry] git init failed for '${packId}' (non-fatal):`, err);
    });

    console.log(`[PackRegistry] Installed pack '${packId}' from local path`);
    return packId;
  }

  /**
   * Walk into extracted directory to find the directory containing pack.json.
   * Handles archives that have a single top-level wrapper directory.
   */
  private async findPackRoot(extractDir: string): Promise<string> {
    if (existsSync(join(extractDir, "pack.json"))) return extractDir;

    const entries = readdirSync(extractDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1) {
      const nested = join(extractDir, dirs[0].name);
      if (existsSync(join(nested, "pack.json"))) return nested;
    }

    throw new Error("Archive does not contain a valid pack (no pack.json found)");
  }

  private async finalizeInstall(packRoot: string): Promise<string> {
    const packJson: PackJson = JSON.parse(
      await readFile(join(packRoot, "pack.json"), "utf-8"),
    );
    const packId = packJson.id;
    if (!packId) throw new Error("pack.json missing required 'id' field");

    const dest = this.resolveDir(packId);
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    await rename(packRoot, dest).catch(async () => {
      await cp(packRoot, dest, { recursive: true });
    });

    // Auto-load Docker image if image.tar is included in the archive
    const imageTar = join(dest, "image.tar");
    if (existsSync(imageTar)) {
      console.log(`[PackRegistry] Loading bundled Docker image for '${packId}'...`);
      await spawnAsync("docker", ["load", "-i", imageTar]).catch((err) => {
        console.warn(`[PackRegistry] docker load failed (non-fatal):`, err);
      });
    }

    await gitEnsure(dest, packId, packJson.version || "1.0.0").catch((err) => {
      console.warn(`[PackRegistry] git init failed for '${packId}' (non-fatal):`, err);
    });

    console.log(`[PackRegistry] Installed pack '${packId}'`);
    return packId;
  }

  private download(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("curl", ["-fsSL", "-o", dest, url], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Download failed (curl exit code ${code}): ${url}`));
      });
      child.on("error", reject);
    });
  }
}

