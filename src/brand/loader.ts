/**
 * Brand pack loader.
 *
 * Resolution order (high to low priority):
 *   1. process.env.FORGEAX_BRAND        — white-label override
 *   2. <repoRoot>/brand/active          — symlink target (operator convenience)
 *   3. 'forgeax'                        — default pack
 *
 * Repo root is located by walking up from process.cwd() / this module until a
 * `brand/` directory containing `defaults.forgeax.json` is found. Tests may
 * pin the brand registry via FORGEAX_BRAND_DIR=<absolute-path>.
 *
 * The loader is memoised — the brand pack does not change after process start.
 * Use `resetBrand()` in tests if you need to rebind.
 */

import { existsSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrandConfig, BrandResolution, BrandSource } from './types';
import { BRAND_SCHEMA_VERSION } from './types';

const DEFAULT_BRAND_ID = 'forgeax';

let cached: BrandResolution | null = null;

function locateBrandRoot(): string {
  const override = process.env.FORGEAX_BRAND_DIR;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`[brand] FORGEAX_BRAND_DIR points to non-existent path: ${override}`);
    }
    return resolve(override);
  }

  const candidates: string[] = [];
  const cwd = process.cwd();
  candidates.push(cwd);
  candidates.push(resolve(cwd, '..'));
  candidates.push(resolve(cwd, '..', '..'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/brand/loader.ts → walk up to repo root (packages/server/src/brand)
    candidates.push(resolve(here, '..', '..', '..', '..'));
    candidates.push(resolve(here, '..', '..', '..'));
  } catch {
    /* import.meta unavailable — skip */
  }

  for (const dir of candidates) {
    const brandDir = resolve(dir, 'brand');
    if (existsSync(join(brandDir, 'defaults.forgeax.json'))) {
      return brandDir;
    }
  }
  throw new Error(`[brand] brand/ directory not found. Tried: ${candidates.join(', ')}`);
}

function pickBrandId(brandRoot: string): { id: string; source: BrandSource } {
  const fromEnv = process.env.FORGEAX_BRAND?.trim();
  if (fromEnv) {
    return { id: fromEnv, source: { kind: 'env', name: 'FORGEAX_BRAND' } };
  }
  const activeLink = join(brandRoot, 'active');
  if (existsSync(activeLink)) {
    try {
      const st = lstatSync(activeLink);
      const target = st.isSymbolicLink()
        ? readlinkSync(activeLink)
        : basename(activeLink);
      // Allow either "defaults.<id>" or bare "<id>" link targets.
      const match = /^(?:defaults\.)?([a-z][a-z0-9-]{1,31})$/.exec(basename(target));
      if (match) {
        return { id: match[1], source: { kind: 'symlink', target } };
      }
    } catch {
      /* fall through to default */
    }
  }
  return { id: DEFAULT_BRAND_ID, source: { kind: 'default' } };
}

function validateConfig(raw: unknown, brandId: string): BrandConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[brand] manifest is not an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== BRAND_SCHEMA_VERSION) {
    throw new Error(`[brand] schemaVersion mismatch: expected ${BRAND_SCHEMA_VERSION}, got ${String(o.schemaVersion)}`);
  }
  if (o.id !== brandId) {
    throw new Error(`[brand] manifest id "${String(o.id)}" does not match pack id "${brandId}"`);
  }
  // Cheap shape check — schema.json is the source of truth, this is a smoke
  // test to fail loudly if someone hand-edits a pack into nonsense.
  for (const k of ['product', 'assistant', 'splash', 'providers', 'links'] as const) {
    if (!o[k] || typeof o[k] !== 'object') {
      throw new Error(`[brand] manifest missing required object field: ${k}`);
    }
  }
  return raw as BrandConfig;
}

export function loadBrand(): BrandResolution {
  if (cached) return cached;
  const overrideDir = process.env.FORGEAX_BRAND_DIR;
  const brandRoot = locateBrandRoot();
  const { id, source } = pickBrandId(brandRoot);
  const manifestPath = join(brandRoot, `defaults.${id}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`[brand] manifest not found: ${manifestPath} (brand id "${id}", source: ${source.kind})`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const config = validateConfig(raw, id);
  const packDir = join(brandRoot, `defaults.${id}`);
  const finalSource: BrandSource = overrideDir
    ? { kind: 'override-dir', dir: overrideDir }
    : source;
  cached = { config, source: finalSource, packDir, manifestPath, brandRoot };
  return cached;
}

export function getBrand(): BrandConfig {
  return loadBrand().config;
}

export function resetBrand(): void {
  cached = null;
}
