/**
 * /api/version — forgeax-studio build/version info.
 *
 *   GET  /api/version  → { version, sha, date, totalCommits, branch, bootedAt }
 *
 * Source order:
 *   1. `FORGEAX_VERSION` env var (set by scripts/run.sh from version.sh)
 *   2. `dist/version.json` written by `bash scripts/version.sh write …`
 *   3. live `git rev-list --count HEAD` + `git log -1` fallback (dev mode)
 *   4. `{ version: "v0.0.0.0-unknown" }` last resort
 *
 * Scheme:  v0.M.D.N
 *   0 — pre-1.0 epoch
 *   M.D — main 最新 commit 的月.日
 *   N — main 自第 1 天起累计 commit 数 (monotone)
 *
 * Used by:
 *   - server boot log (see packages/server/src/main.ts)
 *   - interface bottom-left VersionBadge
 *   - `/api/version` consumers (CLI / external integrations)
 */

import { Hono } from 'hono';
import { readFileSync, existsSync, watch } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface VersionInfo {
  version: string;
  sha: string;
  date: string;
  totalCommits: number;
  branch: string;
  bootedAt: number;
}

let cached: VersionInfo | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 1000; // upper bound on staleness; fs.watch invalidates earlier
let watchersInstalled = false;

function findStudioRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, '.gitmodules')) && existsSync(resolve(dir, '.git'))) return dir;
    dir = resolve(dir, '..');
  }
  return null;
}

function ensureGitWatchers(): void {
  if (watchersInstalled) return;
  watchersInstalled = true; // set first — failed watch shouldn't retry every call
  const root = findStudioRoot();
  if (!root) return;
  const invalidate = () => { cached = null; cachedAt = 0; };
  // HEAD moves on branch switch; refs/heads/main + packed-refs move on commit/fetch.
  // Any of them changing means our cached version is stale.
  for (const sub of ['HEAD', 'refs/heads/main', 'packed-refs']) {
    const p = resolve(root, '.git', sub);
    if (!existsSync(p)) continue;
    try {
      const w = watch(p, invalidate);
      w.on('error', () => { /* watcher dies on rotation; tolerate */ });
    } catch { /* file may not exist on shallow checkout; ignore */ }
  }
}

function fromEnv(): VersionInfo | null {
  const v = process.env.FORGEAX_VERSION;
  if (!v) return null;
  // env-driven fast path. Try to enrich from dist/version.json if it sits next to env.
  const enriched = fromDistFile();
  if (enriched && enriched.version === v) return enriched;
  return {
    version: v,
    sha: enriched?.sha ?? '?',
    date: enriched?.date ?? '?',
    totalCommits: enriched?.totalCommits ?? 0,
    branch: enriched?.branch ?? '?',
    bootedAt: Date.now(),
  };
}

function fromDistFile(): VersionInfo | null {
  // scripts/run.sh writes this on every boot. dist/ is package-local
  // (packages/server/dist/version.json).
  const candidates = [
    resolve(import.meta.dir ?? __dirname, '..', '..', 'dist', 'version.json'),
    resolve(process.cwd(), 'dist', 'version.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        return {
          version: String(raw.version ?? '?'),
          sha: String(raw.sha ?? '?'),
          date: String(raw.date ?? '?'),
          totalCommits: Number(raw.totalCommits ?? 0),
          branch: String(raw.branch ?? '?'),
          bootedAt: Date.now(),
        };
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function fromLiveGit(): VersionInfo | null {
  // Dev mode fallback — query git directly. Must be cheap (cached on first call).
  // Scoped to the studio monorepo root, not packages/server. We walk up until
  // .gitmodules sits beside .git/ — that's forgeax-studio root.
  try {
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (existsSync(resolve(dir, '.gitmodules')) && existsSync(resolve(dir, '.git'))) break;
      dir = resolve(dir, '..');
    }
    const run = (cmd: string): string =>
      execSync(cmd, { cwd: dir, encoding: 'utf-8' }).trim();
    const sha = run('git log -1 --pretty=format:%h HEAD');
    const date = run('git log -1 --pretty=format:%ad --date=short HEAD');
    const md = run("git log -1 --pretty=format:%ad --date=format:'%-m.%-d' HEAD");
    const n = Number(run('git rev-list --count HEAD'));
    const branchRaw = run('git rev-parse --abbrev-ref HEAD');
    const branch = branchRaw === 'HEAD' ? sha : branchRaw;
    return {
      version: `v0.${md}.${n}`,
      sha,
      date,
      totalCommits: n,
      branch,
      bootedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function getVersion(): VersionInfo {
  ensureGitWatchers();
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  // Live git is preferred when a .git/ checkout is present: it's the only
  // source that reflects fresh commits without a daemon restart. fs.watch
  // above invalidates `cached` whenever HEAD/refs/heads/main move (fast
  // path). TTL caps any miss at CACHE_TTL_MS so a flaky watcher / move
  // event we don't subscribe to (packed-refs rotation, etc.) still recovers.
  // FORGEAX_VERSION env + dist/version.json are boot-time snapshots; we
  // fall back to them only for shallow tarballs where fromLiveGit() can't run.
  cached = fromLiveGit() ?? fromEnv() ?? fromDistFile() ?? {
    version: 'v0.0.0.0-unknown',
    sha: '?',
    date: '?',
    totalCommits: 0,
    branch: '?',
    bootedAt: Date.now(),
  };
  cachedAt = Date.now();
  return cached;
}

export function createVersionRouter() {
  const app = new Hono();
  app.get('/', (c) => c.json(getVersion()));
  return app;
}
