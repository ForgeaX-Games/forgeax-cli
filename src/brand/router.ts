/**
 * /api/brand — read-only brand pack endpoint.
 *
 *   GET /api/brand
 *     → { config: BrandConfig, source: BrandSource, assetBaseUrl: '/brand/' }
 *
 *   GET /api/brand/assets/:filename
 *     → static asset from the active pack's assets/ dir
 *
 * The interface ships brand assets via a vite plugin that copies the pack
 * into `public/brand/` at dev/build time, so the assets endpoint is mostly
 * for AI agents that want to inspect the active pack at runtime without
 * walking the disk.
 */

import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { loadBrand } from './loader';

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createBrandRouter(): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    try {
      const { config, source, packDir, manifestPath } = loadBrand();
      return c.json({
        config,
        source,
        assetBaseUrl: '/brand/assets/',
        packDir,
        manifestPath,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  r.get('/assets/:filename{.+}', async (c) => {
    let resolution;
    try {
      resolution = loadBrand();
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
    const filename = c.req.param('filename');
    if (!filename || filename.includes('..') || filename.startsWith('/')) {
      return c.json({ error: 'invalid asset path' }, 400);
    }
    const assetDir = join(resolution.packDir, 'assets');
    const target = normalize(join(assetDir, filename));
    if (!target.startsWith(assetDir)) {
      return c.json({ error: 'asset path escapes pack dir' }, 400);
    }
    // Single async readFile replaces existsSync + readFileSync + statSync
    // (3 sync syscalls → 1 async). Buffer carries its own length so we
    // skip the explicit stat for content-length.
    let body: Buffer;
    try {
      body = await readFile(target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return c.json({ error: `asset not found: ${filename}` }, 404);
      return c.json({ error: (e as Error).message }, 500);
    }
    const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-length': String(body.length),
        'cache-control': 'public, max-age=300',
      },
    });
  });

  return r;
}
