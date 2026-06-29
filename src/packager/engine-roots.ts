/**
 * Engine-root detection for the web/standalone export pipeline.
 *
 * The engine source migrated from `packages/build/engine-src` to
 * `packages/editor/packages/play-runtime`. The export script
 * (`build-standalone.ts`) lives in the old engine-src but its deps (vite,
 * @forgeax/*) + the `.forgeax` games symlink only exist under the live
 * play-runtime. The packager therefore needs to know WHICH engine root to
 * run the export against — this module scans known locations and validates
 * each so the UI can offer a choice.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EngineRootCandidate {
  /** Absolute path to the engine root. */
  path: string;
  /** Short human label for the UI. */
  label: string;
  /** Whether this root can actually run the export (deps present). */
  valid: boolean;
  /** Whether this is the auto-detected default. */
  recommended: boolean;
}

/** Locations (relative to the studio monorepo root) that may host the engine. */
const CANDIDATE_RELS: Array<{ rel: string; label: string }> = [
  { rel: 'packages/editor/packages/play-runtime', label: 'play-runtime (editor)' },
  { rel: 'packages/build/engine-src', label: 'engine-src (legacy)' },
];

/** A candidate can run the export only if vite + the export helpers resolve. */
function isValidEngineRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'node_modules', 'vite')) &&
    existsSync(join(dir, 'pack-catalog.ts')) &&
    existsSync(join(dir, 'src', 'types.ts'))
  );
}

/**
 * Scan known engine-root locations under `studioRoot`. The first valid
 * candidate is marked `recommended`.
 */
export function detectEngineRoots(studioRoot: string): EngineRootCandidate[] {
  const out: EngineRootCandidate[] = [];
  let recommendedAssigned = false;

  for (const { rel, label } of CANDIDATE_RELS) {
    const path = join(studioRoot, rel);
    if (!existsSync(path)) continue;
    const valid = isValidEngineRoot(path);
    const recommended = valid && !recommendedAssigned;
    if (recommended) recommendedAssigned = true;
    out.push({ path, label, valid, recommended });
  }

  return out;
}

/** Convenience: the recommended engine root path, or undefined when none valid. */
export function recommendedEngineRoot(studioRoot: string): string | undefined {
  return detectEngineRoots(studioRoot).find((r) => r.recommended)?.path;
}
