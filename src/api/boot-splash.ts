/**
 * /api/boot-splash — persisted config for the pre-React boot splash.
 *
 *   GET  /api/boot-splash         → { config: SplashConfig | null, persistedAt?: number }
 *   POST /api/boot-splash         → body SplashConfig, writes to disk
 *   POST /api/boot-splash/reset   → delete the on-disk file, return defaults
 *
 * Source of truth: `<projectRoot>/.forgeax/boot-splash.json`. The client
 * mirrors this into localStorage so the inline bootstrap in index.html can
 * read it synchronously on page-load. AI in ChatPanel mutates the splash via
 * `bash` → curl to this endpoint; the next refresh picks up the change.
 *
 * Schema validation is intentionally light (whitelist the few fields we
 * support) — anything else is silently rejected so a stale schema-2 client
 * can't poison schema-1 readers.
 */

import { Hono } from 'hono';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultProjectRoot } from './lib/safe-path';
import { friendlyPath } from './lib/friendly-path';

const VALID_THEMES = new Set(['classic-lime', 'neon-pulse']);
const SCHEMA_VERSION = 1;

interface SplashConfig {
  v: 1;
  theme: 'classic-lime' | 'neon-pulse';
  title: string;
  subtitle: string;
  showProgressBar: boolean;
  showBusInventory: boolean;
}

const DEFAULTS: SplashConfig = {
  v: SCHEMA_VERSION,
  theme: 'classic-lime',
  title: 'forgeax · Studio',
  subtitle: 'booting shell…',
  showProgressBar: true,
  showBusInventory: false,
};

function validate(input: unknown): SplashConfig | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (o.v !== SCHEMA_VERSION) return null;
  if (typeof o.theme !== 'string' || !VALID_THEMES.has(o.theme)) return null;
  if (typeof o.title !== 'string' || typeof o.subtitle !== 'string') return null;
  if (typeof o.showProgressBar !== 'boolean') return null;
  if (typeof o.showBusInventory !== 'boolean') return null;
  // Cap text length so the splash never blows up on a 1MB title.
  if (o.title.length > 200 || o.subtitle.length > 400) return null;
  return {
    v: SCHEMA_VERSION,
    theme: o.theme as SplashConfig['theme'],
    title: o.title,
    subtitle: o.subtitle,
    showProgressBar: o.showProgressBar,
    showBusInventory: o.showBusInventory,
  };
}

function splashPath(): string {
  return resolve(defaultProjectRoot(), '.forgeax', 'boot-splash.json');
}

export function createBootSplashRouter(): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const path = splashPath();
    if (!existsSync(path)) {
      return c.json({ config: null, defaults: DEFAULTS, path: friendlyPath(path) });
    }
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const config = validate(parsed);
      const st = await stat(path);
      return c.json({
        config,
        defaults: DEFAULTS,
        persistedAt: st.mtimeMs,
        path: friendlyPath(path),
      });
    } catch (e) {
      return c.json({ config: null, defaults: DEFAULTS, error: (e as Error).message, path: friendlyPath(path) }, 200);
    }
  });

  r.post('/', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400); }
    const config = validate(body);
    if (!config) {
      return c.json({ ok: false, error: 'invalid splash config (schema v1 only)' }, 400);
    }
    const path = splashPath();
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
      const st = await stat(path);
      return c.json({ ok: true, config, persistedAt: st.mtimeMs, path: friendlyPath(path) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  r.post('/reset', async (c) => {
    const path = splashPath();
    try {
      if (existsSync(path)) await rm(path);
      return c.json({ ok: true, config: null, defaults: DEFAULTS, path: friendlyPath(path) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  return r;
}
