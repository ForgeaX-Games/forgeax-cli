import { Hono } from 'hono';
import { stat, unlink } from 'fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot, resolveSafePath, ALLOWED_TOP_DIRS } from './lib/safe-path';
import { assetRoot } from '../lib/asset-root';
import { readFileSafe, writeFileSafe, listTree, classify } from './lib/io';
import type { TreeNode } from './lib/io';

// `packages/**` are host-bundled, read-only assets (marketplace personas,
// plugin files, …). In the packaged .app they live under assetRoot()
// (= <Resources>/resources), NOT the user's writable project root, so
// resolveSafePath()'s project-root resolution points at a non-existent path.
// Redirect missing `packages/**` reads to the asset root (dev: assetRoot() is
// `packages/`, so the original already exists and this is a no-op).
function resolveReadPath(root: string, rel: string): string | null {
  const abs = resolveSafePath(root, rel);
  if (abs && !existsSync(abs) && rel.startsWith('packages/')) {
    const alt = resolve(assetRoot(), rel.slice('packages/'.length));
    if (existsSync(alt)) return alt;
  }
  return abs;
}

interface WriteBody {
  path?: unknown;
  content?: unknown;
}

export function createFilesRouter() {
  const r = new Hono();

  r.get('/', async (c) => {
    const root = defaultProjectRoot();
    const rel = c.req.query('path') ?? '';
    const abs = resolveReadPath(root, rel);
    if (!abs) return c.json({ error: 'path outside whitelist (games/** or packages/**)' }, 400);
    try {
      const info = await readFileSafe(abs, rel);
      return c.json(info);
    } catch (e) {
      const msg = (e as Error).message;
      // Differentiate dir-vs-missing: tick 351 found the bare GET on a
      // directory returned 404 "not found", masking the fact that the
      // path WAS valid — just the wrong endpoint shape.
      if (msg.startsWith('is a directory')) {
        return c.json({ error: msg }, 400);
      }
      // `optional=1`: the caller probes a file that legitimately may not exist
      // (per-developer launcher state like play-config.json). Return 200
      // { exists:false } so the browser's network panel logs no red 404 for an
      // expected-absent file. 404 stays the default for genuine missing-file
      // errors every other caller relies on. Ported from server hotfix cae7495.
      if (c.req.query('optional') === '1') {
        return c.json({ exists: false, content: null });
      }
      return c.json({ error: 'not found' }, 404);
    }
  });

  r.post('/', async (c) => {
    let body: WriteBody;
    try {
      body = (await c.req.json()) as WriteBody;
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (typeof body?.path !== 'string' || typeof body?.content !== 'string') {
      return c.json({ error: 'fields { path: string, content: string } required' }, 400);
    }
    const root = defaultProjectRoot();
    const abs = resolveSafePath(root, body.path);
    if (!abs) return c.json({ error: 'path outside whitelist (games/** or packages/**)' }, 400);
    try {
      const { bytes } = await writeFileSafe(abs, body.content);
      return c.json({ path: body.path, bytes });
    } catch (e) {
      const msg = (e as Error).message;
      // Same pattern as the GET handler — dir target gets a structured
      // 400 instead of a noisy 500 with raw EISDIR text.
      if (msg.startsWith('target path is a directory')) {
        return c.json({ error: msg }, 400);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/files/upload — write a binary asset to the project (games/**).
  // Body: { path: string, data: string (base64) }
  // The editor's "Import Asset" feature uses this for GLB, PNG, etc. — the
  // string POST /api/files endpoint doesn't handle binary (mojibake risk).
  r.post('/upload', async (c) => {
    let body: { path?: unknown; data?: unknown };
    try { body = await c.req.json() as { path?: unknown; data?: unknown }; }
    catch { return c.json({ error: 'invalid json body' }, 400); }
    if (typeof body?.path !== 'string' || typeof body?.data !== 'string') {
      return c.json({ error: 'fields { path: string, data: string (base64) } required' }, 400);
    }
    const root = defaultProjectRoot();
    const abs = resolveSafePath(root, body.path);
    if (!abs) return c.json({ error: 'path outside whitelist (games/**)' }, 400);
    try {
      const buf = Buffer.from(body.data, 'base64');
      await Bun.write(abs, buf);
      return c.json({ path: body.path, bytes: buf.byteLength });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // GET /api/files/raw?path=<rel> — stream the file bytes with a proper
  // Content-Type so <img>/<audio>/<video>/<model-viewer> can consume it
  // directly. The JSON /api/files route deliberately stops returning bytes
  // for binary kinds (PNG/GLB/MP3/etc were being force-decoded into mojibake);
  // this is the companion endpoint that hands those bytes back unmangled.
  // Whitelist is the same as the JSON route via resolveSafePath.
  r.get('/raw', async (c) => {
    const root = defaultProjectRoot();
    const rel = c.req.query('path') ?? '';
    const abs = resolveReadPath(root, rel);
    if (!abs) return c.json({ error: 'path outside whitelist (games/** or packages/**)' }, 400);
    let s;
    try {
      s = await stat(abs);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    if (s.isDirectory()) {
      return c.json({ error: 'is a directory — use GET /api/files/tree?root=<path>' }, 400);
    }
    const { mime } = classify(rel);
    const f = Bun.file(abs);
    // 媒体资源 (video/* / image/* / audio/*) 走轻量级缓存: 5 分钟内同 url 切换
    // 直接吃浏览器 disk cache, 不走 HTTP. ADR-0019 头像状态机切 state 时多次拉
    // 同一批 webm, no-cache 会让每次切换都打一次 HTTP → 视觉空白窗.
    // 文本/JSON 等仍 no-cache (热重载/编辑场景需要立即看到新内容).
    const isMedia = mime.startsWith('video/') || mime.startsWith('image/') || mime.startsWith('audio/');
    return new Response(f, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(s.size),
        'Cache-Control': isMedia ? 'public, max-age=300' : 'no-cache',
      },
    });
  });

  r.get('/tree', async (c) => {
    const root = defaultProjectRoot();
    const rel = c.req.query('root') ?? '';
    if (!rel) {
      const children: TreeNode[] = [];
      for (const top of ALLOWED_TOP_DIRS) {
        const sub = await listTree(root, top, 4);
        if (sub) children.push(sub);
      }
      return c.json({ tree: { name: '.', path: '', type: 'dir', children } });
    }
    const abs = resolveSafePath(root, rel);
    if (!abs) return c.json({ error: 'path outside whitelist (games/** or packages/**)' }, 400);
    const tree = await listTree(root, rel, 4);
    if (!tree) return c.json({ error: 'not found' }, 404);
    return c.json({ tree });
  });

  r.delete('/', async (c) => {
    const root = defaultProjectRoot();
    const rel = c.req.query('path') ?? '';
    const abs = resolveSafePath(root, rel);
    if (!abs) return c.json({ error: 'path outside whitelist (games/**)' }, 400);
    try {
      await unlink(abs);
      return c.json({ ok: true, path: rel });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ENOENT')) return c.json({ ok: true, path: rel });
      return c.json({ error: msg }, 500);
    }
  });

  return r;
}
