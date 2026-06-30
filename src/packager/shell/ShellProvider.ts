/**
 * ShellProvider — builds (or retrieves from cache) the universal Windows
 * game launcher exe via `bun build --compile`.
 *
 * No Rust required. The launcher source lives at
 * `packages/build/player-launcher/player-launcher.ts`.
 *
 * Cache location: `~/.forgeax/cache/player-shell/forgeax-player-v<V>.exe`
 *   + `shell-meta.json` (version, builtAt).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assetRoot } from '@forgeax/platform-io';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

const SHELL_VERSION = '5';
const EXE_NAME = `forgeax-player-v${SHELL_VERSION}.exe`;
const META_NAME = 'shell-meta.json';

interface ShellMeta {
  version: string;
  builtAt: number;
}

export interface ShellResult {
  ok: boolean;
  exePath?: string;
  cached: boolean;
  error?: string;
}

let buildPromise: Promise<ShellResult> | null = null;

export async function getOrBuildShell(
  cacheDir: string,
  onProgress?: (phase: string, line?: string) => void,
  forceRebuild?: boolean,
): Promise<ShellResult> {
  // Concurrency lock: if a build is already in flight, await it
  if (buildPromise) return buildPromise;

  const shellDir = join(cacheDir, 'player-shell');
  const exePath = join(shellDir, EXE_NAME);
  const metaPath = join(shellDir, META_NAME);

  if (forceRebuild) {
    onProgress?.('shell-build', 'forceRebuild: clearing shell cache');
    rmSync(shellDir, { recursive: true, force: true });
  }

  // Cache hit
  if (existsSync(exePath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ShellMeta;
      if (meta.version === SHELL_VERSION) {
        onProgress?.('shell-build', `cache hit: ${EXE_NAME}`);
        return { ok: true, exePath, cached: true };
      }
    } catch { /* stale meta, rebuild */ }
  }

  // Cache miss — compile
  buildPromise = (async (): Promise<ShellResult> => {
    try {
      onProgress?.('shell-build', 'compiling launcher with bun --compile …');
      mkdirSync(shellDir, { recursive: true });

      const root = studioRoot();
      const launcherSrc = resolve(root, 'packages/build/player-launcher/player-launcher.ts');
      if (!existsSync(launcherSrc)) {
        return { ok: false, cached: false, error: `launcher source not found: ${launcherSrc}` };
      }

      const bunBin = process.execPath || 'bun';
      const proc = Bun.spawn({
        cmd: [
          bunBin, 'build', launcherSrc,
          '--compile',
          '--target=bun-windows-x64',
          '--windows-hide-console',
          `--outfile=${exePath}`,
        ],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (code !== 0) {
        onProgress?.('shell-build', `compile failed (exit ${code})`);
        return {
          ok: false,
          cached: false,
          error: 'bun --compile failed',
          ...(stderr || stdout ? { error: (stderr || stdout).split('\n').slice(-20).join('\n') } : {}),
        };
      }

      const meta: ShellMeta = { version: SHELL_VERSION, builtAt: Date.now() };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      onProgress?.('shell-build', `compiled → ${EXE_NAME}`);

      return { ok: true, exePath, cached: false };
    } catch (e) {
      return { ok: false, cached: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      buildPromise = null;
    }
  })();

  return buildPromise;
}
