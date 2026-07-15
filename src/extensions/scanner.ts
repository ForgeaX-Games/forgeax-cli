/**
 * Phase B1 — ManifestScanner.
 *
 * Walks the three plugin layers (L0 builtin / L1 user / L2 project) and
 * returns parsed ExtensionManifest[] tagged by origin. Zod-validation goes
 * through `@forgeax/types`, so any divergence between scanner and
 * marketplace manifest grammar surfaces here as a typed error.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.1
 * for the L0/L1/L2 contract and 13-MIGRATION-ROADMAP §B1.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseManifest } from '@forgeax/types';
import type { ExtensionManifest } from '@forgeax/types';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';

export type ExtensionLayer = 'L0' | 'L1' | 'L2';

export interface ScannedManifest {
  layer: ExtensionLayer;
  originPath: string;
  manifest: ExtensionManifest;
}

export interface ScanError {
  layer: ExtensionLayer;
  originPath: string;
  reason: string;
}

export interface ScanResult {
  found: ScannedManifest[];
  errors: ScanError[];
}

/** Resolve the canonical root directory for each layer.
 *
 *  L0: `<repo>/packages/marketplace/extensions`
 *  L1: `~/.forgeax/extensions`
 *  L2: `<projectRoot>/.forgeax/extensions`
 *
 *  Returns null for a layer when its root doesn't exist (so newcomers
 *  without ~/.forgeax don't trip an error). Caller can override roots
 *  via `opts` for tests. */
/** ADR 0025 M3.5 — user-disk layer migration (the sanctioned compat
 *  exception, same family as the scanner's legacy-id normalize): machines
 *  from before the Extension rename carry `.forgeax/plugins` layer dirs.
 *  Rename once at the single resolution point; idempotent — skipped when
 *  the new dir already exists or the legacy one is absent. */
function migrateLegacyLayerDir(base: string): void {
  const legacy = resolve(base, '.forgeax/plugins');
  const current = resolve(base, '.forgeax/extensions');
  try {
    if (safeIsDir(legacy) && !safeIsDir(current)) {
      renameSync(legacy, current);
      console.warn(`[extensions/scanner] migrated legacy layer dir ${legacy} -> ${current}`);
    }
  } catch (e) {
    console.warn(`[extensions/scanner] legacy layer dir migration failed (${legacy}): ${(e as Error).message}`);
  }
}

export function defaultLayerRoots(opts?: { repoRoot?: string; projectRoot?: string }): Record<ExtensionLayer, string | null> {
  const repoRoot = opts?.repoRoot ?? findRepoRoot();
  const projectRoot = opts?.projectRoot ?? defaultProjectRoot();
  migrateLegacyLayerDir(homedir());
  if (projectRoot) migrateLegacyLayerDir(projectRoot);
  const candidates = (paths: string[]) => paths.find((p) => safeIsDir(p)) ?? null;
  return {
    // L0 (host-bundled marketplace). assetRoot() resolves to `packages/` in dev
    // and `<Resources>/resources/` in the packaged .app, so this single
    // candidate covers both — crucial because findRepoRoot() can't locate a
    // `packages/marketplace` in the bundle (marketplace lives at
    // resources/marketplace) and would otherwise yield 0 plugins.
    L0: candidates([
      resolve(assetRoot(), 'marketplace/extensions'),
      ...(repoRoot
        ? [
            resolve(repoRoot, 'packages/marketplace/extensions'),
            resolve(repoRoot, 'marketplace/extensions'),
          ]
        : []),
    ]),
    L1: candidates([resolve(homedir(), '.forgeax/extensions')]),
    L2: projectRoot ? candidates([resolve(projectRoot, '.forgeax/extensions')]) : null,
  };
}

/** Best-effort repo root finder: walks up from this file until it sees
 *  a directory with `packages/marketplace`. Allows the scanner to work
 *  when invoked from any CWD. */
function findRepoRoot(): string | null {
  let dir = resolve(import.meta.dirname, '..', '..', '..', '..');
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

async function scanLayer(layer: ExtensionLayer, root: string): Promise<ScanResult> {
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
    const extensionDir = join(root, name);
    if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && safeIsDir(extensionDir))) continue;
    const manifestPath = join(extensionDir, 'forgeax-extension.json');
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
      // ADR 0025 M3 — persistent-id namespace migration: manifests authored
      // before the Extension rename carry `@forgeax-plugin/*`. Normalize at
      // this single read point so user-forked L1/L2 extensions (old ids on
      // the user's disk — the sanctioned compat exception) keep resolving.
      if (typeof parsed.manifest.id === 'string' && parsed.manifest.id.startsWith('@forgeax-plugin/')) {
        const legacyId = parsed.manifest.id;
        parsed.manifest.id = legacyId.replace('@forgeax-plugin/', '@forgeax-extension/');
        console.warn(`[extensions/scanner] normalized legacy id ${legacyId} -> ${parsed.manifest.id} (${manifestPath})`);
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
  roots?: Partial<Record<ExtensionLayer, string | null>>,
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
