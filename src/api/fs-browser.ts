/**
 * Filesystem browser endpoint — lets the Studio UI walk the server's
 * filesystem to pick a directory as a workspace. Separate from /api/files
 * (which is whitelisted to FORGEAX_PROJECT_ROOT/{games,packages,.forgeax/games}
 * via resolveSafePath) because workspace selection by definition needs to
 * reach OUTSIDE the current project root.
 *
 * Safety:
 *   - tilde expansion (~ / ~/foo) using $HOME
 *   - absolute path required
 *   - reject NUL byte
 *   - directory blocklist (system mounts that have no business being a
 *     ForgeaX workspace and that could surface sensitive content)
 *
 *   GET /api/fs/browse?dir=<abs|~/foo>
 */

import { Hono } from 'hono';
import { readdir, stat, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { friendlyPath } from './lib/friendly-path';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const DIR_BLOCKLIST_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/var/run',
  '/var/lib/docker',
  '/run',
  '/boot',
];

function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function isBlocklisted(absPath: string): boolean {
  for (const prefix of DIR_BLOCKLIST_PREFIXES) {
    if (absPath === prefix) return true;
    if (absPath.startsWith(prefix + '/')) return true;
  }
  return false;
}

interface Entry {
  name: string;
  isDir: boolean;
  hasForgeaX: boolean;
  hasGames: boolean;
}

export function createFsBrowserRouter(): Hono {
  const r = new Hono();

  r.get('/browse', async (c) => {
    const raw = (c.req.query('dir') ?? '~').trim();
    if (raw.includes('\0')) return c.json({ error: 'invalid path (NUL byte)' }, 400);

    let abs = expandTilde(raw);
    if (!isAbsolute(abs)) return c.json({ error: 'dir must be an absolute path or start with ~' }, 400);
    abs = resolve(abs);

    if (isBlocklisted(abs)) {
      return c.json({ error: `${friendlyPath(abs)} is on the system blocklist` }, 400);
    }

    let st;
    try { st = await stat(abs); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return c.json({ error: `not found: ${friendlyPath(abs)}` }, 404);
      return c.json({ error: (e as Error).message }, 500);
    }
    if (!st.isDirectory()) return c.json({ error: `not a directory: ${friendlyPath(abs)}` }, 400);

    // readdir({withFileTypes:true}) replaces a per-entry statSync — we get
    // dirent.isDirectory() for free. The 3 existsSync probes per dir are
    // launched concurrently with Promise.all so the workspace picker can
    // browse a 100-entry dir without serializing 400 stat calls.
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
    const visibleDirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    const entries: Entry[] = await Promise.all(visibleDirs.map(async (d) => {
      const child = join(abs, d.name);
      const [hasForgeaX, hasForgeaxGames, hasGamesTop] = await Promise.all([
        exists(join(child, '.forgeax')),
        exists(join(child, '.forgeax', 'games')),
        exists(join(child, 'games')),
      ]);
      return { name: d.name, isDir: true, hasForgeaX, hasGames: hasForgeaxGames || hasGamesTop };
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const [selfHasForgeaX, selfHasForgeaxGames, selfHasGamesTop] = await Promise.all([
      exists(join(abs, '.forgeax')),
      exists(join(abs, '.forgeax', 'games')),
      exists(join(abs, 'games')),
    ]);

    const parent = dirname(abs);
    return c.json({
      dir: abs,
      dirDisplay: friendlyPath(abs),
      parent: parent === abs ? null : parent,
      parentDisplay: parent === abs ? null : friendlyPath(parent),
      name: basename(abs) || abs,
      selfHasForgeaX,
      selfHasGames: selfHasForgeaxGames || selfHasGamesTop,
      entries,
    });
  });

  return r;
}
