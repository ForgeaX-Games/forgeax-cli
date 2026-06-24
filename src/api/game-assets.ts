// game-assets.ts — manifest endpoint: GET /api/games/:slug/assets-scripts (M4 w20).
//
// Scans .forgeax/games/<slug>/assets/ for all .ts files (recursive, no
// forced assets/scripts/ sub-directory). Returns [{relPath, absPath}] JSON.
//
// Uses resolveSafePath whitelist where .forgeax/games is already allowed.
// Path traversal attacks (../../etc/passwd) are rejected by the whitelist.
//
// Distinct from /api/files/tree: this is a lightweight TS-script-only view,
// not a depth-4 full file tree.
//
// Anchors:
//   plan-tasks.json w20: server assets manifest endpoint
//   plan-strategy D-3: light-weight manifest, reuses safe-path whitelist
//   requirements AC-07: scan assets/ scripts, no forced assets/scripts/ sub-dir

import { Hono } from 'hono';
import { readdir } from 'fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defaultProjectRoot, resolveSafePath } from './lib/safe-path';

/** Slug must be a non-empty string with only safe characters. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

interface ScriptEntry {
  relPath: string;
  absPath: string;
}

/**
 * Recursively collect .ts files under a directory.
 * Returns absolute paths (for /@fs/ import) and relative paths (for tracking).
 */
async function collectTsFiles(
  dir: string,
  base: string,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await collectTsFiles(fullPath, base);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        // Use forward-slash relative paths for consistency with web URLs.
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — return empty.
  }
  return results;
}

export function createGameAssetsRouter() {
  const r = new Hono();

  r.get('/:slug/assets-scripts', async (c) => {
    const slug = c.req.param('slug');

    // Validate slug format (prevent path traversal via slug itself).
    if (!slug || typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return c.json({ error: 'invalid slug' }, 400);
    }

    const root = defaultProjectRoot();
    const relPath = `.forgeax/games/${slug}/assets`;

    // Resolve through the safe-path whitelist (.forgeax/games is already allowed).
    const absDir = resolveSafePath(root, relPath);
    if (!absDir) {
      return c.json({ error: 'path outside whitelist' }, 400);
    }

    // Check that the directory exists.
    if (!existsSync(absDir)) {
      return c.json({ scripts: [] });
    }

    // Collect all .ts files recursively.
    let absPaths: string[];
    try {
      absPaths = await collectTsFiles(absDir, absDir);
    } catch {
      return c.json({ error: 'failed to scan directory' }, 500);
    }

    // Build the response: [{relPath, absPath}].
    const scripts: ScriptEntry[] = absPaths.map((abs) => {
      // relPath: relative to the .forgeax/games/<slug>/assets/ base.
      // e.g., assets/patrol.ts → patrol.ts
      //       assets/scripts/enemy.ts → scripts/enemy.ts
      const rel = abs.slice(absDir.length + 1); // +1 for trailing slash
      return { relPath: rel, absPath: abs };
    });

    return c.json({ scripts });
  });

  return r;
}