// @desc Index upstream skill marketplace — extract all SKILL.md frontmatter into a searchable cache.
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { join } from "node:path";
import YAML from "yaml";
import type { AgentContext } from "#src/core/types.js";
import { getTerminalManager } from "#src/terminal/manager.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface UpstreamSkillEntry {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
}

export interface UpstreamIndex {
  upstream: string;
  upstreamBasePath: string;
  cachedAtMs: number;
  entries: UpstreamSkillEntry[];
}

function cacheDir(ctx: AgentContext): string {
  // team/shared-workspace/.cache/skills-index — team-level runtime cache,
  // not synced to pack (shared-workspace is never pack-shared).
  return join(ctx.pathManager.team().sharedWorkspace(), ".cache", "skills-index");
}

function indexFilePath(ctx: AgentContext): string {
  return join(cacheDir(ctx), "index.json");
}

/**
 * Load existing index if fresh; return null when missing, stale, or
 * upstream-config mismatch (requires re-fetch).
 */
function loadFreshIndex(
  ctx: AgentContext,
  upstream: string,
  upstreamBasePath: string,
): UpstreamIndex | null {
  const indexPath = indexFilePath(ctx);
  if (!getSandboxFs().existsSync(indexPath)) return null;
  try {
    const raw = getSandboxFs().readTextSync(indexPath);
    const parsed = JSON.parse(raw) as UpstreamIndex;
    if (parsed.upstream !== upstream || parsed.upstreamBasePath !== upstreamBasePath) return null;
    if (Date.now() - parsed.cachedAtMs > CACHE_TTL_MS) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Refresh upstream skill index: download tarball, extract all SKILL.md files,
 * parse frontmatter, write cache to `team/shared-workspace/.cache/skills-index/index.json`.
 *
 * Returns null on unrecoverable failure (e.g. network error) — caller should
 * gracefully report to user; never throws.
 */
async function refreshIndex(
  ctx: AgentContext,
  upstream: string,
  upstreamBasePath: string,
  isAborted: () => boolean,
): Promise<UpstreamIndex | null> {
  const root = cacheDir(ctx);
  getSandboxFs().mkdirSync(root);
  const workDir = join(root, `refresh-${ctx.agentId}-${Date.now()}`);
  getSandboxFs().mkdirSync(workDir);
  const tarballPath = join(workDir, "upstream.tar.gz");

  try {
    try {
      const res = await fetch(upstream);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (isAborted()) return null;
      getSandboxFs().writeBinarySync(tarballPath, buf);
    } catch (err: any) {
      console.warn(`[skill-indexer] download failed: ${err?.message || err}`);
      return null;
    }

    // Extract only SKILL.md files under upstreamBasePath/<skill>/SKILL.md.
    // `--wildcards` lets tar interpret `*` in the pattern; the pattern itself
    // is anchored at tarball root, so `--no-anchored` is not needed.
    // Result: ~60 small files instead of the full tarball (~8MB saved).
    const extractDir = join(workDir, "extract");
    getSandboxFs().mkdirSync(extractDir);
    try {
      getTerminalManager().execSync(
        "tar",
        [
          "-xzf",
          tarballPath,
          "-C",
          extractDir,
          "--wildcards",
          `${upstreamBasePath}/*/SKILL.md`,
        ],
        { timeout: 60_000 },
      );
    } catch (err: any) {
      console.warn(`[skill-indexer] extraction failed: ${err?.message || err}`);
      return null;
    }

    const skillsRoot = join(extractDir, upstreamBasePath);
    const entries: UpstreamSkillEntry[] = [];
    if (getSandboxFs().existsSync(skillsRoot)) {
      for (const name of getSandboxFs().readdirSync(skillsRoot)) {
        const st = getSandboxFs().statSync(join(skillsRoot, name));
        if (!st?.isDirectory) continue;
        const skillPath = join(skillsRoot, name, "SKILL.md");
        if (!getSandboxFs().existsSync(skillPath)) continue;
        const entry = parseSkillFrontmatter(skillPath, name);
        if (entry) entries.push(entry);
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const index: UpstreamIndex = {
      upstream,
      upstreamBasePath,
      cachedAtMs: Date.now(),
      entries,
    };
    getSandboxFs().writeTextSync(indexFilePath(ctx), JSON.stringify(index, null, 2));
    console.info(`[skill-indexer] indexed ${entries.length} skill(s) from ${upstream}`);
    return index;
  } finally {
    try { getSandboxFs().rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Get upstream skill index. Reads cache if fresh, otherwise refreshes.
 * Returns null if refresh fails and no cache exists.
 */
export async function getUpstreamIndex(
  ctx: AgentContext,
  upstream: string,
  upstreamBasePath: string,
  opts: { forceRefresh?: boolean; isAborted?: () => boolean } = {},
): Promise<UpstreamIndex | null> {
  const isAborted = opts.isAborted ?? (() => false);
  if (!opts.forceRefresh) {
    const fresh = loadFreshIndex(ctx, upstream, upstreamBasePath);
    if (fresh) return fresh;
  }
  return refreshIndex(ctx, upstream, upstreamBasePath, isAborted);
}

function parseSkillFrontmatter(
  skillPath: string,
  dirName: string,
): UpstreamSkillEntry | null {
  try {
    const raw = getSandboxFs().readTextSync(skillPath);
    const match = raw.match(FRONTMATTER_RE);
    if (!match) return { name: dirName, description: deriveDescription(raw) };

    const parsed = YAML.parse(match[1]);
    if (!isRecord(parsed)) return { name: dirName, description: deriveDescription(raw) };

    const name = typeof parsed.name === "string" ? parsed.name.trim() : dirName;
    const description =
      typeof parsed.description === "string"
        ? parsed.description.trim()
        : deriveDescription(raw.slice(match[0].length));
    const license = typeof parsed.license === "string" ? parsed.license.trim() : undefined;
    const compatibility =
      typeof parsed.compatibility === "string" ? parsed.compatibility.trim() : undefined;

    return { name, description, license, compatibility };
  } catch {
    return null;
  }
}

function deriveDescription(body: string): string {
  const firstPara = body
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.replace(/\r?\n/g, " ").trim())
    .find(Boolean);
  return firstPara ?? "No description provided.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
