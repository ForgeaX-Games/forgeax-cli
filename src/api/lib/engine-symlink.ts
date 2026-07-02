// Re-point engine-src/.forgeax → <workspaceRoot>/.forgeax. Used by workspace
// hot-switch (POST /api/workspaces/activate). Idempotent. Engine vite uses
// polling so the next watcher tick picks up the new game tree without a
// process restart.
//
// Lifted out of the deleted src/orchestrator/spawn.ts (subprocess model is
// gone; this stayed because it's pure fs work, not subprocess management).

import { resolve, join } from 'node:path';
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';

function monorepoRoot(): string {
  // src/api/lib → climb 4 to monorepo root
  return resolve(import.meta.dirname, '..', '..', '..', '..', '..');
}

const ROOT = monorepoRoot();
const ENGINE_SRC_DIR = join(ROOT, 'packages', 'editor', 'packages', 'play-runtime');

export function repointEngineForgeaXSymlink(workspaceRoot: string): string {
  if (!existsSync(ENGINE_SRC_DIR)) {
    throw new Error('engine-src dir missing — release artifact mode cannot hot-switch');
  }
  const target = join(workspaceRoot, '.forgeax');
  const link = join(ENGINE_SRC_DIR, '.forgeax');
  mkdirSync(join(workspaceRoot, '.forgeax', 'games'), { recursive: true });
  let existing: ReturnType<typeof lstatSync> | null = null;
  try { existing = lstatSync(link); } catch { /* not present */ }
  if (existing) {
    if (existing.isSymbolicLink()) {
      try { unlinkSync(link); } catch (e) {
        throw new Error(`could not unlink ${link}: ${(e as Error).message}`);
      }
    } else {
      throw new Error(`${link} is a real directory; cannot hot-switch — restart stack manually`);
    }
  }
  // Windows symlinks require elevation; junction does not. Safe on POSIX too
  // (Node ignores the type arg there). Ported from server hotfix bf08966.
  symlinkSync(target, link, 'junction');
  return target;
}
