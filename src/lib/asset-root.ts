/**
 * Asset root resolver — the single anchor for the server's APP-bundled
 * read-only assets (plugin dist trees, interface SPA dist, builtin kits,
 * brand). This is distinct from the user's WRITABLE workspace
 * (`FORGEAX_PROJECT_ROOT`, see api/lib/safe-path.ts) — never conflate them.
 *
 * Why this exists (desktop packaging):
 *   In dev / source runs, asset dirs are found relative to this module via
 *   `import.meta.dir`. But once the server is packaged into a desktop app
 *   (Tauri sidecar — Phase B), `import.meta.dir` no longer points at the repo
 *   layout: a `bun --compile` binary reports a virtual path (`/$bunfs/...`),
 *   and even a non-compiled sidecar lives under the .app's Resources, not the
 *   source tree. Every mature shell (Electron `process.resourcesPath`, Tauri
 *   `resource_dir()`, Node SEA `process.execPath`) solves this the same way:
 *   resolve assets from an injected/binary-relative anchor, not the module.
 *
 * Resolution order (first hit wins):
 *   1. FORGEAX_RESOURCE_ROOT — injected by the Tauri shell (Rust) from
 *      `app.path().resource_dir()`. Authoritative in the packaged app.
 *   2. process.execPath-adjacent — fallback anchor for a `bun --compile`
 *      binary whose `import.meta.dir` is virtual (looks for a sibling layout).
 *   3. import.meta.dir-relative — dev / source runs. Behavior is IDENTICAL to
 *      before this refactor when FORGEAX_RESOURCE_ROOT is unset.
 *
 * The resolved root mirrors the repo `packages/` layout, so callers ask for
 * `marketplace/plugins/<id>/dist`, `interface/dist`, etc. The desktop payload
 * script lays Resources out the same way.
 */
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

let cached: string | null = null;

export function assetRoot(): string {
  if (cached) return cached;

  // 1. Explicit injection from the desktop shell (packaged app).
  const injected = process.env.FORGEAX_RESOURCE_ROOT;
  if (injected) {
    cached = injected;
    return cached;
  }

  // 2. bun --compile: import.meta.dir is a virtual /$bunfs path. Look for a
  //    resource layout next to the real on-disk binary (process.execPath).
  //    We only trust this if it actually contains our asset layout, so a
  //    normal `bun run` (where execPath is the bun binary itself) doesn't
  //    accidentally win over the dev fallback below.
  const meta = import.meta.dir ?? '';
  const isVirtual = meta.startsWith('/$bunfs') || meta.startsWith('B:\\~BUN') || meta === '';
  if (isVirtual) {
    const execDir = dirname(process.execPath);
    for (const cand of [execDir, resolve(execDir, '..', 'Resources'), resolve(execDir, 'resources')]) {
      if (existsSync(resolve(cand, 'interface', 'dist'))) {
        cached = cand;
        return cached;
      }
    }
    // Last resort in a compiled binary: trust execDir even if probe failed.
    cached = execDir;
    return cached;
  }

  // 3. Dev / source run — mirror the pre-refactor `resolve(import.meta.dir,
  //    '../../...')` from main.ts. This module is packages/server/src/lib, so
  //    the `packages/` root is three levels up.
  cached = resolve(meta, '..', '..', '..');
  return cached;
}

/** Path under a marketplace plugin, e.g. mp('wb-character', 'dist'). */
export function mp(...segments: string[]): string {
  return resolve(assetRoot(), 'marketplace', 'plugins', ...segments);
}

/** The built interface SPA dist (single-origin / desktop form). */
export function interfaceDist(): string {
  return resolve(assetRoot(), 'interface', 'dist');
}
