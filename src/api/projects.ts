/**
 * Project = an agentic working directory.
 *
 *   Filesystem:
 *     <projectsRoot>/<projectId>/
 *       .forgeax/agenteam-state/instances/<projectId>/   ← agent state
 *       games/                                            ← games for this project
 *       marketplace/   (optional, symlinked from sibling) ← persona / skills
 *
 *   In cli terms = one INSTANCE. cli daemon supports multi-instance via its
 *   own /api/instances endpoint, but each instance needs its state-dir
 *   discoverable. For MVP we limit to: projects living as siblings of the
 *   current project root, sharing the cli daemon.
 *
 *   GET    /api/projects             list { projects[], current }
 *   POST   /api/projects             create { id, displayName? } — scaffolds
 *                                    new sibling under defaultProjectRoot()'s parent.
 *   POST   /api/projects/open        register an existing arbitrary directory
 *                                    as a workspace { path, label?, initIfMissing? }.
 *                                    Persists to ~/.forgeax/known-projects.json.
 *   DELETE /api/projects/registered  un-register an arbitrary workspace (does
 *                                    NOT delete the directory) { path }.
 *   DELETE /api/projects/:id         rm -rf a sibling-style project.
 */

import { Hono } from 'hono';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from './lib/safe-path';
import { friendlyPath } from './lib/friendly-path';
import { loadKnown, addKnown, removeKnown } from './lib/known-projects';
import { scaffoldDefaultWorkspace } from './lib/scaffold-default-workspace';

/**
 * Valid project id: 2-41 chars, [a-z0-9] first then [a-z0-9-_]*.
 * Intentionally laxer than GAME_SLUG_RE — workspace ids surface mainly
 * as filesystem dirs at the sibling level; underscores acceptable here
 * because no engine URL ever embeds them. Exported for tests (cc-game/21).
 */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-_]{1,40}$/;

interface ProjectRow {
  id: string;
  path: string;
  /** Raw absolute path — used by client for DELETE /registered + restart cmd. */
  absPath: string;
  displayName: string;
  mtime: number;
  isCurrent: boolean;
  hasGames: boolean;
  hasState: boolean;
  /** 'sibling' = ambient sibling dir; 'registered' = entry from known-projects.json */
  source: 'sibling' | 'registered';
}

function looksLikeProject(dir: string): boolean {
  return existsSync(join(dir, '.forgeax')) || existsSync(join(dir, 'games'));
}

function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function buildRow(dir: string, currentProjectRoot: string, source: ProjectRow['source']): ProjectRow | null {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return null;
    return {
      id: basename(dir),
      path: friendlyPath(dir),
      absPath: dir,
      displayName: basename(dir),
      mtime: st.mtimeMs,
      isCurrent: dir === currentProjectRoot,
      hasGames: existsSync(join(dir, '.forgeax/games')) || existsSync(join(dir, 'games')),
      hasState: existsSync(join(dir, '.forgeax')),
      source,
    };
  } catch { return null; }
}

export function createProjectsRouter(): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const currentProjectRoot = defaultProjectRoot();
    const parent = dirname(currentProjectRoot);
    const seen = new Set<string>();
    const out: ProjectRow[] = [];

    // Sibling walk — preserve historical behavior (ambient project discovery).
    try {
      for (const entry of readdirSync(parent)) {
        if (entry.startsWith('.') || entry.startsWith('_')) continue;
        const dir = join(parent, entry);
        if (!existsSync(dir)) continue;
        if (!looksLikeProject(dir)) continue;
        const row = buildRow(dir, currentProjectRoot, 'sibling');
        if (row) {
          seen.add(dir);
          out.push(row);
        }
      }
    } catch { /* parent unreadable — skip silently */ }

    // Registered workspaces — anywhere on disk. Dedup by abs path against
    // the sibling walk so a path that happens to sit next to the current
    // project doesn't double-render.
    for (const k of loadKnown()) {
      if (seen.has(k.path)) continue;
      const row = buildRow(k.path, currentProjectRoot, 'registered');
      if (row) {
        if (k.label) row.displayName = k.label;
        seen.add(k.path);
        out.push(row);
      }
    }

    out.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || b.mtime - a.mtime);
    return c.json({
      projects: out,
      current: basename(currentProjectRoot),
      currentAbs: currentProjectRoot,
      currentPath: friendlyPath(currentProjectRoot),
      root: friendlyPath(parent),
    });
  });

  r.post('/', async (c) => {
    let body: { id?: string; displayName?: string };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid json' }, 400); }
    const id = String(body?.id ?? '').trim();
    if (!PROJECT_ID_RE.test(id)) {
      return c.json({ error: 'id must be 2-41 chars lowercase ascii/digits/-/_' }, 400);
    }
    const currentProjectRoot = defaultProjectRoot();
    const parent = dirname(currentProjectRoot);
    const dir = join(parent, id);
    if (existsSync(dir)) return c.json({ error: `${id} already exists`, dir: friendlyPath(dir) }, 409);
    try {
      await mkdir(join(dir, '.forgeax/games'), { recursive: true });
      await mkdir(join(dir, '.forgeax/agenteam-state'), { recursive: true });
      await writeFile(
        join(dir, 'README.md'),
        `# ${body.displayName ?? id}\n\nForgeaX agentic workspace. Created ${new Date().toISOString()}.\n`,
        'utf-8',
      );
      // Copy _template stub from current project's .forgeax/games/_template if present.
      const templateSrc = join(currentProjectRoot, '.forgeax/games', '_template');
      if (existsSync(templateSrc)) {
        const { cp } = await import('node:fs/promises');
        await cp(templateSrc, join(dir, '.forgeax/games', '_template'), { recursive: true });
      }
      return c.json({ ok: true, id, dir: friendlyPath(dir), absDir: dir });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Register an arbitrary existing directory as a workspace.
   * Optionally scaffold a `_default` game stub so the engine preview pipeline
   * has something to render when the directory has no real game yet.
   */
  r.post('/open', async (c) => {
    let body: { path?: string; label?: string; initIfMissing?: boolean };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid json' }, 400); }
    const raw = String(body?.path ?? '').trim();
    if (!raw) return c.json({ error: 'path required' }, 400);
    if (raw.includes('\0')) return c.json({ error: 'invalid path (NUL byte)' }, 400);

    let abs = expandTilde(raw);
    if (!isAbsolute(abs)) return c.json({ error: 'path must be absolute or start with ~' }, 400);
    abs = resolvePath(abs);

    if (!existsSync(abs)) return c.json({ error: `not found: ${friendlyPath(abs)}` }, 404);
    let st;
    try { st = statSync(abs); }
    catch (e) { return c.json({ error: (e as Error).message }, 500); }
    if (!st.isDirectory()) return c.json({ error: `not a directory: ${friendlyPath(abs)}` }, 400);

    const initIfMissing = body.initIfMissing !== false; // default true
    const hasGamesDir = existsSync(join(abs, '.forgeax', 'games')) || existsSync(join(abs, 'games'));
    let initialized = false;
    let slug: string | undefined;
    if (initIfMissing && !hasGamesDir) {
      try {
        const r = scaffoldDefaultWorkspace(abs);
        initialized = r.created;
        slug = r.slug;
      } catch (e) {
        return c.json({ error: `scaffold failed: ${(e as Error).message}` }, 500);
      }
    }

    const label = body.label ? String(body.label).trim() || undefined : undefined;
    const entry = addKnown(abs, label);

    return c.json({
      ok: true,
      path: friendlyPath(abs),
      absPath: abs,
      label: entry.label,
      initialized,
      slug,
    });
  });

  /**
   * Un-register an arbitrary workspace from ~/.forgeax/known-projects.json.
   * Does NOT touch the directory on disk — this is critical because
   * registered workspaces can be anywhere (user code repos, etc.).
   * Different from DELETE /:id which `rm -rf`s sibling-style projects.
   */
  r.delete('/registered', async (c) => {
    const queryPath = c.req.query('path');
    let path: string | undefined = queryPath;
    if (!path) {
      try {
        const body = (await c.req.json()) as { path?: string };
        path = body?.path;
      } catch { /* no body, no query → fall through */ }
    }
    if (!path) return c.json({ error: 'path required (query or json body)' }, 400);
    const abs = resolvePath(expandTilde(path));
    const removed = removeKnown(abs);
    if (!removed) return c.json({ error: 'not in registry', path: friendlyPath(abs) }, 404);
    return c.json({ ok: true, path: friendlyPath(abs) });
  });

  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!PROJECT_ID_RE.test(id ?? '')) {
      return c.json({ error: 'invalid id' }, 400);
    }
    const currentProjectRoot = defaultProjectRoot();
    if (basename(currentProjectRoot) === id) {
      return c.json({ error: 'cannot delete the currently-active project; switch first' }, 400);
    }
    const dir = join(dirname(currentProjectRoot), id);
    if (!existsSync(dir)) return c.json({ error: 'not found', dir: friendlyPath(dir) }, 404);
    try {
      await rm(dir, { recursive: true, force: true });
      // Also drop from the registry if it happened to be tracked there.
      removeKnown(dir);
      return c.json({ ok: true, id, dir: friendlyPath(dir) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return r;
}
