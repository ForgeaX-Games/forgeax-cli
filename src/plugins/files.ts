/**
 * Doc 09 §2.1 — minimum-viable plugin file editor backend.
 *
 * The wb-plugin-author panel needs to read/write files inside an L2 plugin
 * directory. The constraints we enforce here are the only thing that keeps
 * this safe from shell injection / arbitrary disk writes:
 *
 *   1. Plugin slug is matched against `[A-Za-z0-9_-]+`. Anything with `..`,
 *      `/`, or `\\` is rejected at parse time.
 *   2. All file operations resolve under `<projectRoot>/.forgeax/plugins/<slug>/`
 *      and we re-check the resolved real path is still inside that prefix.
 *   3. File extensions are whitelisted to text formats the editor knows how
 *      to render. Binary writes are rejected.
 *   4. File size cap (256 KiB) — enough for hand-written manifest + a couple
 *      of skill modules; trips before someone uploads a video.
 *
 * If a single one of these fails, we return a typed error code so the UI can
 * say something specific instead of a 500.
 *
 * What this DOES NOT do:
 *   - mkdir / delete (the recorder + fork creates dirs; deletion lives on a
 *     follow-up "trash plugin" gesture).
 *   - rename across paths (same reason).
 *   - permission engine integration (read/write here is unconditionally
 *     allowed for the studio operator; AI-driven authoring goes through
 *     ToolRegistry which already gates).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;
const ALLOWED_EXT = new Set([
  '.json', '.md', '.txt', '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.css', '.html', '.svg',
]);
const MAX_BYTES = 256 * 1024;

export type FileError =
  | { ok: false; code: 'bad_slug'; error: string }
  | { ok: false; code: 'not_found'; error: string }
  | { ok: false; code: 'forbidden'; error: string }
  | { ok: false; code: 'too_large'; error: string }
  | { ok: false; code: 'bad_ext'; error: string }
  | { ok: false; code: 'io_error'; error: string };

export interface PluginFileEntry {
  /** Path relative to plugin root, POSIX style. */
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  mtime?: number;
}

export type ListResult =
  | { ok: true; pluginDir: string; entries: PluginFileEntry[] }
  | FileError;

export type ReadResult =
  | { ok: true; path: string; content: string; size: number; mtime: number }
  | FileError;

export type WriteResult =
  | { ok: true; path: string; size: number }
  | FileError;

function pluginRoot(projectRoot: string, slug: string): string {
  return join(projectRoot, '.forgeax', 'plugins', slug);
}

function checkSlug(slug: string): { ok: true } | FileError {
  if (!slug || !SAFE_SLUG.test(slug)) {
    return { ok: false, code: 'bad_slug', error: `slug must match ${SAFE_SLUG} (got ${JSON.stringify(slug)})` };
  }
  return { ok: true };
}

function checkInside(root: string, candidate: string): { ok: true } | FileError {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c !== r && !c.startsWith(r + '/')) {
    return { ok: false, code: 'forbidden', error: `path escapes plugin dir: ${candidate}` };
  }
  return { ok: true };
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

/** List files under a plugin dir. Recurses but skips node_modules / .git. */
export function listPluginFiles(projectRoot: string, slug: string): ListResult {
  const slugCheck = checkSlug(slug);
  if (!slugCheck.ok) return slugCheck;
  const dir = pluginRoot(projectRoot, slug);
  if (!existsSync(dir)) return { ok: false, code: 'not_found', error: `plugin dir missing: ${dir}` };

  const entries: PluginFileEntry[] = [];
  function walk(abs: string): void {
    let kids: string[] = [];
    try { kids = readdirSync(abs); } catch { return; }
    for (const name of kids) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.DS_Store')) continue;
      const childAbs = join(abs, name);
      let st;
      try { st = statSync(childAbs); } catch { continue; }
      const rel = relative(dir, childAbs).split(/[\\/]/).join('/');
      if (st.isDirectory()) {
        entries.push({ path: rel, kind: 'dir' });
        walk(childAbs);
      } else if (st.isFile()) {
        entries.push({ path: rel, kind: 'file', size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  walk(dir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, pluginDir: dir, entries };
}

/** Read a single file under the plugin dir. */
export function readPluginFile(projectRoot: string, slug: string, relPath: string): ReadResult {
  const slugCheck = checkSlug(slug);
  if (!slugCheck.ok) return slugCheck;
  if (!relPath || relPath.includes('\\') || relPath.startsWith('/')) {
    return { ok: false, code: 'forbidden', error: `relPath must be a relative POSIX path` };
  }
  const dir = pluginRoot(projectRoot, slug);
  const abs = resolve(dir, relPath);
  const inside = checkInside(dir, abs);
  if (!inside.ok) return inside;
  if (!existsSync(abs)) return { ok: false, code: 'not_found', error: `file missing: ${relPath}` };
  let st;
  try { st = statSync(abs); } catch (e) {
    return { ok: false, code: 'io_error', error: e instanceof Error ? e.message : String(e) };
  }
  if (!st.isFile()) return { ok: false, code: 'forbidden', error: `not a regular file: ${relPath}` };
  if (st.size > MAX_BYTES) return { ok: false, code: 'too_large', error: `file > ${MAX_BYTES} bytes` };
  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch (e) {
    return { ok: false, code: 'io_error', error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, path: relPath, content, size: st.size, mtime: st.mtimeMs };
}

/** Write a file under the plugin dir. Creates parent dirs. */
export function writePluginFile(
  projectRoot: string,
  slug: string,
  relPath: string,
  content: string,
): WriteResult {
  const slugCheck = checkSlug(slug);
  if (!slugCheck.ok) return slugCheck;
  if (!relPath || relPath.includes('\\') || relPath.startsWith('/')) {
    return { ok: false, code: 'forbidden', error: `relPath must be a relative POSIX path` };
  }
  if (typeof content !== 'string') {
    return { ok: false, code: 'io_error', error: 'content must be a string' };
  }
  const ext = extOf(relPath);
  if (!ALLOWED_EXT.has(ext)) {
    return { ok: false, code: 'bad_ext', error: `extension ${ext || '<none>'} not in allow-list` };
  }
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_BYTES) {
    return { ok: false, code: 'too_large', error: `content > ${MAX_BYTES} bytes` };
  }
  const dir = pluginRoot(projectRoot, slug);
  if (!existsSync(dir)) {
    return { ok: false, code: 'not_found', error: `plugin dir missing: ${dir}` };
  }
  const abs = resolve(dir, relPath);
  const inside = checkInside(dir, abs);
  if (!inside.ok) return inside;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  } catch (e) {
    return { ok: false, code: 'io_error', error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, path: relPath, size: bytes };
}
