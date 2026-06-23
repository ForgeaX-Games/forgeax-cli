/**
 * Workspace hot-switch — flip the running stack to point at a different
 * filesystem directory without a manual `bash run.sh` restart.
 *
 *   POST /api/workspaces/activate { path, initIfMissing? } → {
 *     ok: true,
 *     path, absPath,
 *     scaffolded: boolean,
 *   }
 *
 *   GET  /api/workspaces/active → { absPath, path, hasGames, activeSlug? }
 *
 * Behavior on activate:
 *   1. Validate path (exists, is a directory, not on blocklist).
 *   2. If `initIfMissing && !hasGamesDir(path)` → scaffold _default game stub.
 *   3. Update `process.env.FORGEAX_PROJECT_ROOT = absPath`.
 *      Backend code reads this lazily via `defaultProjectRoot()` so all
 *      subsequent per-request handlers see the new root.
 *   4. Repoint `packages/build/engine-src/.forgeax` symlink → `<absPath>/.forgeax`.
 *      Engine vite is polling the symlink target so it picks up the new
 *      tree on the next watcher tick — no subprocess restart needed.
 *   5. Add the path to the known-projects registry.
 *   6. Broadcast a `workspace-changed` WS event so live tabs reload.
 *
 * Caveat: in-process state initialized at startup against the OLD root
 * (fsWatcher etc.) is not re-scoped. UI is expected to do a full
 * `location.reload()` after activation, which re-fetches per-request
 * endpoints that all read defaultProjectRoot() lazily.
 */

import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from './lib/safe-path';
import { friendlyPath } from './lib/friendly-path';
import { addKnown } from './lib/known-projects';
import { scaffoldDefaultWorkspace } from './lib/scaffold-default-workspace';
import { repointEngineForgeaXSymlink } from './lib/engine-symlink';
import { getActiveGame } from '../api/lib/active-game';
import { initPathManager } from '../fs/path-manager';

const DIR_BLOCKLIST_PREFIXES = [
  '/proc', '/sys', '/dev', '/etc', '/var/run', '/var/lib/docker', '/run', '/boot',
];

function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function isBlocklisted(abs: string): boolean {
  for (const p of DIR_BLOCKLIST_PREFIXES) {
    if (abs === p) return true;
    if (abs.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * True iff the workspace already has at least one valid game slug. Filters
 * out hidden + underscore-prefixed entries (matches `detectActiveSlug` logic
 * — those are scaffold/cache dirs, not real games).
 */
function hasGames(dir: string): boolean {
  const candidates = [join(dir, '.forgeax', 'games'), join(dir, 'games')];
  for (const gamesDir of candidates) {
    if (!existsSync(gamesDir)) continue;
    try {
      for (const e of readdirSync(gamesDir)) {
        if (e.startsWith('.') || e.startsWith('_')) continue;
        if (statSync(join(gamesDir, e)).isDirectory()) return true;
      }
    } catch { /* skip unreadable */ }
  }
  return false;
}

export interface WorkspacesRouterDeps {
  /** Optional WS broadcast hook so live tabs can react to activations. */
  broadcast?: (msg: unknown) => void;
  /** Optional hook to re-point the boot-time FsWatcher at the new root. Without
   *  it the watcher stays bound to the original projectRoot, so file events from
   *  the activated workspace's .forgeax/games never reach live tabs. */
  rebindWatcher?: (rootDir: string) => void | Promise<void>;
}

export function createWorkspacesRouter(deps: WorkspacesRouterDeps = {}): Hono {
  const r = new Hono();

  r.get('/active', (c) => {
    const abs = defaultProjectRoot();
    return c.json({
      absPath: abs,
      path: friendlyPath(abs),
      hasGames: hasGames(abs),
      hasForgeaX: existsSync(join(abs, '.forgeax')),
    });
  });

  r.post('/activate', async (c) => {
    let body: { path?: string; label?: string; initIfMissing?: boolean };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid json' }, 400); }
    const raw = String(body?.path ?? '').trim();
    if (!raw) return c.json({ error: 'path required' }, 400);
    if (raw.includes('\0')) return c.json({ error: 'invalid path (NUL byte)' }, 400);

    let abs = expandTilde(raw);
    if (!isAbsolute(abs)) return c.json({ error: 'path must be absolute or start with ~' }, 400);
    abs = resolvePath(abs);
    if (isBlocklisted(abs)) return c.json({ error: `${friendlyPath(abs)} is on the system blocklist` }, 400);

    if (!existsSync(abs)) return c.json({ error: `not found: ${friendlyPath(abs)}` }, 404);
    let st;
    try { st = statSync(abs); }
    catch (e) { return c.json({ error: (e as Error).message }, 500); }
    if (!st.isDirectory()) return c.json({ error: `not a directory: ${friendlyPath(abs)}` }, 400);

    const oldRoot = defaultProjectRoot();

    // 1. Scaffold if missing.
    const initIfMissing = body.initIfMissing !== false;
    let scaffolded = false;
    if (initIfMissing && !hasGames(abs)) {
      try {
        const r = scaffoldDefaultWorkspace(abs);
        scaffolded = r.created;
      } catch (e) {
        return c.json({ error: `scaffold failed: ${(e as Error).message}` }, 500);
      }
    }

    // 2. Update env BEFORE restarting children — children inherit current env.
    process.env.FORGEAX_PROJECT_ROOT = abs;
    initPathManager({ projectRoot: abs });

    // 3. Repoint engine .forgeax symlink. Engine vite uses polling so the
    //    next watcher tick picks up new files; the explicit child restart
    //    below is belt-and-suspenders for caches that don't invalidate.
    try {
      repointEngineForgeaXSymlink(abs);
    } catch (e) {
      // Roll back env so the rest of the server still points at the old root.
      process.env.FORGEAX_PROJECT_ROOT = oldRoot;
      initPathManager({ projectRoot: oldRoot });
      return c.json({ error: `symlink swap failed: ${(e as Error).message}` }, 500);
    }

    // 4. Engine vite is polling the symlink target — the swap above is
    //    enough; no subprocess restart needed (subprocess model removed
    //    along with src/orchestrator). Interface vite serves the same
    //    source regardless of project root.

    // 5. Register + re-point the fs watcher at the new root so file events
    //    from the activated workspace surface to live tabs.
    addKnown(abs, body.label ? String(body.label).trim() || undefined : undefined);
    try { await deps.rebindWatcher?.(abs); } catch { /* non-fatal — watcher rebind is best-effort */ }

    // 6. Resolve the slug the UI should pin so PreviewMode's iframe lands on
    //    a real, loadable game rather than the engine's rainbow-cube fallback.
    //    Use getActiveGame (explicit active-game.json binding first, mtime
    //    fallback second) — the same SSOT every other consumer reads — so the
    //    pinned slug can't diverge from the workspace's recorded active game.
    //    Fall back to the scaffold's known slug when we just created it.
    const activeSlug = getActiveGame(abs) ?? (scaffolded ? 'workspace' : undefined);

    // 7. Broadcast (UI listens via /ws and will reload).
    try {
      deps.broadcast?.({ type: 'workspace-changed', absPath: abs, path: friendlyPath(abs), activeSlug });
    } catch { /* ignore */ }

    return c.json({
      ok: true,
      path: friendlyPath(abs),
      absPath: abs,
      scaffolded,
      activeSlug,
    });
  });

  return r;
}
