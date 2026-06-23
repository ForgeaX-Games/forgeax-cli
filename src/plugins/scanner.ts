/**
 * Phase B1 — ManifestScanner.
 *
 * Walks the three plugin layers (L0 builtin / L1 user / L2 project) and
 * returns parsed PluginManifest[] tagged by origin. Zod-validation goes
 * through `@forgeax/types`, so any divergence between scanner and
 * marketplace manifest grammar surfaces here as a typed error.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.1
 * for the L0/L1/L2 contract and 13-MIGRATION-ROADMAP §B1.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseManifest } from '@forgeax/types';
import type { PluginManifest } from '@forgeax/types';
import { defaultProjectRoot } from '../api/lib/safe-path';
import { assetRoot } from '../lib/asset-root';

export type PluginLayer = 'L0' | 'L1' | 'L2';

export interface ScannedManifest {
  layer: PluginLayer;
  originPath: string;
  manifest: PluginManifest;
}

export interface ScanError {
  layer: PluginLayer;
  originPath: string;
  reason: string;
}

export interface ScanResult {
  found: ScannedManifest[];
  errors: ScanError[];
}

/** Resolve the canonical root directory for each layer.
 *
 *  L0: `<repo>/packages/marketplace/plugins`
 *  L1: `~/.forgeax/plugins`
 *  L2: `<projectRoot>/.forgeax/plugins`
 *
 *  Returns null for a layer when its root doesn't exist (so newcomers
 *  without ~/.forgeax don't trip an error). Caller can override roots
 *  via `opts` for tests. */
export function defaultLayerRoots(opts?: { repoRoot?: string; projectRoot?: string }): Record<PluginLayer, string | null> {
  const repoRoot = opts?.repoRoot ?? findRepoRoot();
  const projectRoot = opts?.projectRoot ?? defaultProjectRoot();
  const candidates = (paths: string[]) => paths.find((p) => safeIsDir(p)) ?? null;
  return {
    // L0 (host-bundled marketplace). assetRoot() resolves to `packages/` in dev
    // and `<Resources>/resources/` in the packaged .app, so this single
    // candidate covers both — crucial because findRepoRoot() can't locate a
    // `packages/marketplace` in the bundle (marketplace lives at
    // resources/marketplace) and would otherwise yield 0 plugins.
    L0: candidates([
      resolve(assetRoot(), 'marketplace/plugins'),
      ...(repoRoot
        ? [
            resolve(repoRoot, 'packages/marketplace/plugins'),
            resolve(repoRoot, 'marketplace/plugins'),
          ]
        : []),
    ]),
    L1: candidates([resolve(homedir(), '.forgeax/plugins')]),
    L2: projectRoot ? candidates([resolve(projectRoot, '.forgeax/plugins')]) : null,
  };
}

/** Best-effort repo root finder: walks up from this file until it sees
 *  a directory with `packages/marketplace`. Allows the scanner to work
 *  when invoked from any CWD. */
function findRepoRoot(): string | null {
  let dir = resolve(import.meta.dir, '..', '..', '..', '..');
  for (let i = 0; i < 4; i += 1) {
    if (safeIsDir(join(dir, 'packages', 'marketplace'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function safeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function scanLayer(layer: PluginLayer, root: string): Promise<ScanResult> {
  const out: ScanResult = { found: [], errors: [] };
  // Async + withFileTypes — kills the per-entry statSync probe for "is this a
  // directory?" and the readdir itself stops blocking the event loop. The
  // existsSync on manifestPath is also gone; we just try-readFile and let
  // ENOENT surface as a 'continue' below.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    out.errors.push({ layer, originPath: root, reason: `readdir failed: ${(e as Error).message}` });
    return out;
  }
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith('.')) continue;
    const pluginDir = join(root, name);
    if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && safeIsDir(pluginDir))) continue;
    const manifestPath = join(pluginDir, 'forgeax-plugin.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // not a plugin dir, just skip
      out.errors.push({ layer, originPath: manifestPath, reason: (e as Error).message });
      continue;
    }
    try {
      const json = JSON.parse(raw);
      const parsed = parseManifest(json);
      if (!parsed.ok || !parsed.manifest) {
        const reason = parsed.error
          ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'zod parse failed';
        out.errors.push({ layer, originPath: manifestPath, reason });
        continue;
      }
      // Doc 14 §4 — refuse entry.standalone.devOnly:true under production.
      // Authors use this to ship `bun --watch` shims without leaking into
      // packaged builds; the scanner is the right rejection point because
      // the manifest hasn't entered the kind registry yet.
      if (
        isProduction() &&
        parsed.manifest.entry?.standalone?.devOnly === true
      ) {
        out.errors.push({
          layer,
          originPath: manifestPath,
          reason: 'entry.standalone.devOnly:true rejected under production (FORGEAX_NODE_ENV=production)',
        });
        continue;
      }
      out.found.push({ layer, originPath: manifestPath, manifest: parsed.manifest });
    } catch (e) {
      out.errors.push({ layer, originPath: manifestPath, reason: (e as Error).message });
    }
  }
  return out;
}

/** Doc 14 §4 spike — Safe Boot: when `FORGEAX_SAFE_BOOT=1`, skip L1+L2
 *  scans so the host can be edited without a broken plugin breaking it.
 *  L0 (in-tree marketplace) is always scanned because the host bundles it.
 *  Returns `true` when safe-boot is active. */
export function isSafeBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_SAFE_BOOT;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Doc 14 §4 spike — Production gate for `entry.standalone.devOnly`.
 *  Reads `FORGEAX_NODE_ENV` (preferred — explicit) and falls back to
 *  `NODE_ENV`. Only the literal "production" counts. Used by the scanner
 *  to refuse devOnly standalone entries in packaged builds. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_NODE_ENV ?? env.NODE_ENV;
  return v === 'production';
}

/** Scan all three layers. Caller usually passes the result through
 *  ManifestMerger to dedupe by id. Honours `FORGEAX_SAFE_BOOT=1` by
 *  scanning L0 only. */
export async function scanAllLayers(
  roots?: Partial<Record<PluginLayer, string | null>>,
): Promise<ScanResult> {
  const resolved = { ...defaultLayerRoots(), ...(roots ?? {}) };
  const merged: ScanResult = { found: [], errors: [] };
  const safe = isSafeBoot();
  for (const layer of ['L0', 'L1', 'L2'] as const) {
    if (safe && layer !== 'L0') continue;
    const root = resolved[layer];
    if (!root) continue;
    const r = await scanLayer(layer, root);
    merged.found.push(...r.found);
    merged.errors.push(...r.errors);
  }
  return merged;
}
