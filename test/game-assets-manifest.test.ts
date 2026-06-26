// w20 — server assets manifest endpoint test.
//
// Verifies:
//   (a) GET /api/games/:slug/assets-scripts returns [{relPath,absPath}] for .ts files.
//   (b) Returns empty array when assets dir doesn't exist.
//   (c) Rejects invalid slugs.
//   (d) Rejects path traversal via slug.
//
// Anchors:
//   plan-tasks.json w20: server assets manifest endpoint
//   plan-strategy D-3: light-weight TS-script manifest, uses safe-path whitelist

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { createGameAssetsRouter } from '@forgeax/platform-io';

let projectRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-game-assets-'));
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  prevEnv = process.env.FORGEAX_PROJECT_ROOT;

  // Create game assets directory with .ts files.
  const assetsDir = join(projectRoot, '.forgeax', 'games', 'test-game', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'health.ts'), '// fixture');
  writeFileSync(join(assetsDir, 'patrol.ts'), '// fixture');

  // Sub-directory (recursive scan).
  const nestedDir = join(assetsDir, 'scripts');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'enemy.ts'), '// fixture');

  // A non-.ts file should NOT appear in results.
  writeFileSync(join(assetsDir, 'README.md'), '# Not a TS file');
});

afterEach(() => {
  if (prevEnv !== undefined) {
    process.env.FORGEAX_PROJECT_ROOT = prevEnv;
  } else {
    delete process.env.FORGEAX_PROJECT_ROOT;
  }
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/api/games', createGameAssetsRouter());
  return app;
}

describe('w20 — server assets manifest endpoint', () => {
  it('returns [{relPath,absPath}] for all .ts files under assets/', async () => {
    const app = createTestApp();

    const res = await app.request('/api/games/test-game/assets-scripts');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('scripts');

    const scripts = body.scripts as Array<{ relPath: string; absPath: string }>;
    expect(Array.isArray(scripts)).toBe(true);
    expect(scripts.length).toBe(3);

    // Sort for deterministic checks.
    const relPaths = scripts.map((s) => s.relPath).sort();
    expect(relPaths).toContain('health.ts');
    expect(relPaths).toContain('patrol.ts');
    expect(relPaths).toContain('scripts/enemy.ts');

    // All absPaths should be absolute.
    for (const s of scripts) {
      expect(s.absPath.startsWith('/')).toBe(true);
      expect(existsSync(s.absPath)).toBe(true);
    }
  });

  it('returns empty scripts array when assets dir does not exist', async () => {
    const app = createTestApp();

    const res = await app.request('/api/games/nonexistent/assets-scripts');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scripts).toEqual([]);
  });

  it('returns 400 for invalid slug format', async () => {
    const app = createTestApp();

    // Slug with path traversal characters.
    const res = await app.request(
      '/api/games/..%2F..%2Fetc%2Fpasswd/assets-scripts',
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for path traversal via slug (../../etc/passwd)', async () => {
    const app = createTestApp();

    const res = await app.request('/api/games/%2e%2e%2f%2e%2e%2fetc%2Fpasswd/assets-scripts');
    expect(res.status).toBe(400);
  });

  it('route does not match when slug is empty (Hono 404)', async () => {
    const app = createTestApp();

    // Hono `/api/games/:slug/assets-scripts` won't match `/api/games//assets-scripts`
    // because the `:slug` param requires a non-empty segment.
    const res = await app.request('/api/games//assets-scripts');
    expect(res.status).toBe(404);
  });
});