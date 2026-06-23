import { stat, mkdir, readdir } from 'fs/promises';
import { dirname, extname, join } from 'path';

export type FileKind = 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';

export interface FileInfo {
  path: string;
  kind: FileKind;
  mime: string;
  size: number;
  mtime: number;
  /** Present only when kind==='text'. Binary kinds skip the decode and
   *  expect the UI to fetch /api/files/raw for the bytes. */
  content?: string;
}

const EXT_KIND: Record<string, { kind: FileKind; mime: string }> = {
  '.png':  { kind: 'image', mime: 'image/png' },
  '.jpg':  { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif':  { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.bmp':  { kind: 'image', mime: 'image/bmp' },
  '.ico':  { kind: 'image', mime: 'image/x-icon' },
  '.svg':  { kind: 'image', mime: 'image/svg+xml' },
  '.mp3':  { kind: 'audio', mime: 'audio/mpeg' },
  '.wav':  { kind: 'audio', mime: 'audio/wav' },
  '.ogg':  { kind: 'audio', mime: 'audio/ogg' },
  '.m4a':  { kind: 'audio', mime: 'audio/mp4' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.aac':  { kind: 'audio', mime: 'audio/aac' },
  '.mp4':  { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov':  { kind: 'video', mime: 'video/quicktime' },
  '.glb':  { kind: 'model', mime: 'model/gltf-binary' },
  '.gltf': { kind: 'model', mime: 'model/gltf+json' },
};

export function classify(path: string): { kind: FileKind; mime: string } {
  const ext = extname(path).toLowerCase();
  const hit = EXT_KIND[ext];
  if (hit) return hit;
  return { kind: 'text', mime: 'text/plain; charset=utf-8' };
}

export async function readFileSafe(absPath: string, rel: string): Promise<FileInfo> {
  // stat first so we can distinguish missing path from directory path —
  // Bun.file(dir).text() throws a generic EISDIR that the GET /api/files
  // handler used to surface as "not found" (confusing: the dir *does*
  // exist). Now directories get their own thrown message so the route
  // can map it to a clearer "use /tree" hint if it wants.
  let s;
  try {
    s = await stat(absPath);
  } catch {
    throw new Error('not found');
  }
  if (s.isDirectory()) throw new Error('is a directory — use GET /api/files/tree?root=<path>');
  const { kind, mime } = classify(rel);
  // Binary kinds: skip text decode (was producing the PNG-as-mojibake in
  // the workbench preview). UI fetches bytes from /api/files/raw instead.
  if (kind !== 'text') {
    return { path: rel, kind, mime, size: s.size, mtime: s.mtimeMs };
  }
  const f = Bun.file(absPath);
  const content = await f.text();
  return { path: rel, kind, mime, content, size: s.size, mtime: s.mtimeMs };
}

export async function writeFileSafe(absPath: string, content: string): Promise<{ bytes: number }> {
  // Symmetric guard with readFileSafe (tick 352): if a caller submits a
  // path that's already a directory, Bun.write would throw a raw EISDIR
  // that surfaces as a noisy 500. A structured error lets the route map
  // it to a clear 400 instead.
  try {
    const s = await stat(absPath);
    if (s.isDirectory()) throw new Error('target path is a directory — cannot write file content over it');
  } catch (e) {
    // Re-throw the structured directory error; ignore the "doesn't exist
    // yet" case (mkdir below handles the parent dir).
    if ((e as Error).message?.startsWith('target path is a directory')) throw e;
  }
  await mkdir(dirname(absPath), { recursive: true });
  const bytes = await Bun.write(absPath, content);
  return { bytes };
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

const SKIP_NAMES = new Set(['node_modules', '.git', '.forgeax', 'dist', 'build', '.cache']);

export async function listTree(
  root: string,
  rel: string,
  maxDepth = 4,
): Promise<TreeNode | null> {
  const abs = rel ? join(root, rel) : root;
  let s;
  try {
    s = await stat(abs);
  } catch {
    return null;
  }
  const name = rel ? rel.split(/[/\\]/).pop() || rel : '.';
  if (!s.isDirectory()) {
    return { name, path: rel, type: 'file' };
  }
  if (maxDepth <= 0) {
    return { name, path: rel, type: 'dir' };
  }
  const entries = await readdir(abs, { withFileTypes: true });
  const children: TreeNode[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (SKIP_NAMES.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const sub = await listTree(root, childRel, maxDepth - 1);
      if (sub) children.push(sub);
    } else if (e.isFile()) {
      children.push({ name: e.name, path: childRel, type: 'file' });
    }
  }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { name, path: rel, type: 'dir', children };
}
