// @desc Idempotent skill downloader from upstream skill marketplace
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { join } from "node:path";
import type { AgentContext } from "#src/core/types.js";
import { getTerminalManager } from "#src/terminal/manager.js";

/**
 * Single source of truth for defaults — imported by condition.ts (configDefaults),
 * plugins/skill_bootstrap.ts (runtime fallback), and tools/fetch_skill.ts.
 *
 * Runtime code still needs inline `?? DEFAULT` fallback even though
 * configDefaults persists the values to agent-overrides.json, because
 * BaseLoader.mergeDefaults() writes to disk but does not reload the in-memory
 * agentJson before plugin.start() / tool.execute() runs on the first turn
 * (pre-existing timing issue). Exporting the defaults here keeps all three
 * consumers in sync without hand-maintaining duplicated literals.
 */
export const DEFAULT_SKILLS = ["skill-creator"];
export const DEFAULT_UPSTREAM = "https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz";
export const DEFAULT_UPSTREAM_BASE_PATH = "skills-main/skills";

export interface BootstrapConfig {
  skills: string[];
  upstream: string;
  upstreamBasePath: string;
}

export type FetchStatus = "installed" | "skipped" | "not_in_upstream" | "download_failed" | "install_failed";

export interface FetchResult {
  name: string;
  status: FetchStatus;
  path?: string;
  message?: string;
}

/**
 * Fetch the listed skills from `upstream` tarball into `targetSkillsDir`.
 *
 * Idempotent: per-skill `<targetSkillsDir>/<name>/SKILL.md` existence check skips.
 * All failures are captured into FetchResult — never throws — because skills are
 * methodology augmentation, not hard dependencies.
 *
 * Used by both on-demand tool (fetch_skill) and startup plugin (skill_bootstrap).
 */
export async function fetchSkillsToDir(
  ctx: AgentContext,
  skillNames: string[],
  targetSkillsDir: string,
  upstream: string,
  upstreamBasePath: string,
  isAborted: () => boolean,
): Promise<FetchResult[]> {
  const results: FetchResult[] = [];
  const missing = skillNames.filter((name) => {
    if (getSandboxFs().existsSync(join(targetSkillsDir, name, "SKILL.md"))) {
      results.push({ name, status: "skipped", path: join(targetSkillsDir, name) });
      return false;
    }
    return true;
  });
  if (missing.length === 0) return results;

  // team/shared-workspace/.cache/skills-bootstrap — team-level runtime workdir,
  // not synced to pack. Per-agent subdir avoids concurrent delete races.
  const cacheRoot = join(ctx.pathManager.team().sharedWorkspace(), ".cache", "skills-bootstrap");
  const workDir = join(cacheRoot, `${ctx.agentId}-${Date.now()}`);
  getSandboxFs().mkdirSync(workDir);
  const tarballPath = join(workDir, "upstream.tar.gz");

  try {
    try {
      const res = await fetch(upstream);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (isAborted()) return results;
      getSandboxFs().writeBinarySync(tarballPath, buf);
    } catch (err: any) {
      const message = `download failed: ${err?.message || err}`;
      console.warn(`[skill-downloader] ${message}`);
      for (const name of missing) results.push({ name, status: "download_failed", message });
      return results;
    }

    getSandboxFs().mkdirSync(targetSkillsDir);
    const extractDir = join(workDir, "extract");
    getSandboxFs().mkdirSync(extractDir);

    for (const name of missing) {
      if (isAborted()) break;
      const targetPath = join(targetSkillsDir, name);
      // Race check：其他 agent 可能已经装好了
      if (getSandboxFs().existsSync(join(targetPath, "SKILL.md"))) {
        results.push({ name, status: "skipped", path: targetPath });
        continue;
      }

      const subpath = `${upstreamBasePath}/${name}`;
      try {
        // tar 命令通过 TerminalManager 跑在容器，team/instance 路径 same-path mount 可见
        getTerminalManager().execSync(
          "tar",
          ["-xzf", tarballPath, "-C", extractDir, subpath],
          { timeout: 60_000 },
        );
      } catch (err: any) {
        const message = `not in upstream: ${err?.message || err}`;
        console.warn(`[skill-downloader] ${name} ${message}`);
        results.push({ name, status: "not_in_upstream", message });
        continue;
      }

      const extractedPath = join(extractDir, subpath);
      if (!getSandboxFs().existsSync(join(extractedPath, "SKILL.md"))) {
        const message = "SKILL.md missing in extracted tree";
        console.warn(`[skill-downloader] ${name}: ${message}`);
        results.push({ name, status: "not_in_upstream", message });
        continue;
      }

      try {
        getSandboxFs().renameSync(extractedPath, targetPath);
        console.info(`[skill-downloader] installed ${name} → ${targetPath}`);
        results.push({ name, status: "installed", path: targetPath });
      } catch (err: any) {
        // rename 失败多半是 race：另一 agent 先放好了
        if (getSandboxFs().existsSync(join(targetPath, "SKILL.md"))) {
          results.push({ name, status: "skipped", path: targetPath });
          continue;
        }
        const message = `install failed: ${err?.message || err}`;
        console.warn(`[skill-downloader] ${name} ${message}`);
        results.push({ name, status: "install_failed", message });
      }
    }
  } finally {
    try { getSandboxFs().rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return results;
}

/**
 * Thin wrapper for startup plugin — fetches missing skills into team/skills/.
 * See fetchSkillsToDir for the core implementation.
 */
export async function bootstrapMissingSkills(
  ctx: AgentContext,
  config: BootstrapConfig,
  isAborted: () => boolean,
): Promise<void> {
  const teamSkillsDir = join(ctx.pathManager.team().root(), "skills");
  await fetchSkillsToDir(ctx, config.skills, teamSkillsDir, config.upstream, config.upstreamBasePath, isAborted);
}
