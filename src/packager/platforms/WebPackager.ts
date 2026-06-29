/**
 * Web platform packager — produces a self-contained static site.
 *
 * Wraps the existing `build-standalone.ts` / `build-reel-standalone.ts`
 * scripts.  Reel games (detected via `isReelGame()`) are routed to the
 * reel bundler.
 *
 * If `rebuildEngine` is true, the Rust→WASM engine core (wgpu-wasm) is
 * compiled first via the isolated toolchain.
 */

import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IGamePackager, PackageOptions, PackageResult } from '../IGamePackager';
import { friendlyPath, assetRoot } from '@forgeax/platform-io';
import { buildWasmCore } from '../shell/toolchain';
import { detectEngineRoots, recommendedEngineRoot } from '../engine-roots';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

function isReelGame(gameDir: string): boolean {
  try {
    const p = join(gameDir, 'reel', 'scenarios.json');
    if (!existsSync(p)) return false;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0;
  } catch {
    return false;
  }
}

export class WebPackager implements IGamePackager {
  readonly platform = 'web' as const;

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, outDir, rebuildEngine, onProgress } = opts;

    // Optional: rebuild engine WASM core
    if (rebuildEngine) {
      onProgress?.('engine-rebuild', 'rebuilding wgpu-wasm engine core …');
      const wasmResult = await buildWasmCore(onProgress);
      if (!wasmResult.ok) {
        return {
          ok: false,
          slug,
          platform: 'web',
          rebuiltEngine: true,
          error: 'engine WASM core rebuild failed',
          detail: wasmResult.error,
        };
      }
    }

    const reel = isReelGame(gameDir);
    const root = studioRoot();

    if (reel) {
      return this.buildReel({ slug, outDir, root, onProgress });
    }
    return this.buildEngine({ slug, gameDir, outDir, root, engineRoot: opts.engineRoot, rebuildEngine, onProgress });
  }

  /**
   * Engine (3D, non-reel) export.
   *
   * The export script lives in the legacy engine-src but its deps (vite,
   * @forgeax/*) + the `.forgeax` games symlink only exist under the live
   * engine root (play-runtime). We copy the script one level under the
   * selected engine root so bun resolves bare imports + `../pack-catalog.ts`
   * there, and pass FORGEAX_ENGINE_ROOT so the script targets that root.
   */
  private async buildEngine(args: {
    slug: string;
    gameDir: string;
    outDir: string;
    root: string;
    engineRoot?: string;
    rebuildEngine?: boolean;
    onProgress?: (phase: string, line?: string) => void;
  }): Promise<PackageResult> {
    const { slug, gameDir, outDir, root, rebuildEngine, onProgress } = args;

    // Resolve + validate the engine root.
    const engineRoot = args.engineRoot ?? recommendedEngineRoot(root);
    if (!engineRoot) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: 'no usable engine root found',
        detail: `candidates: ${JSON.stringify(detectEngineRoots(root))}`,
      };
    }
    const valid = detectEngineRoots(root).some((r) => r.path === engineRoot && r.valid);
    if (!valid && !this.looksLikeEngineRoot(engineRoot)) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: 'selected engine root is invalid (missing vite / pack-catalog.ts / src/types.ts)',
        detail: engineRoot,
      };
    }

    const scriptSrc = resolve(root, 'packages/build/engine-src/export/build-standalone.ts');
    if (!existsSync(scriptSrc)) {
      return { ok: false, slug, platform: 'web', error: `export script not found: ${scriptSrc}` };
    }

    // Bundle the game the studio is actually running (server's project root),
    // not whatever the engine root's .forgeax junction happens to point at.
    if (!existsSync(gameDir)) {
      return { ok: false, slug, platform: 'web', error: `game not found: ${friendlyPath(gameDir)}` };
    }

    const exportTmpDir = join(engineRoot, '.forgeax-export');
    const scriptDst = join(exportTmpDir, 'build-standalone.ts');
    // Copy the game physically under the engine root so its bare imports
    // (@forgeax/*) resolve from the engine root's node_modules.
    const gameDst = join(exportTmpDir, 'games', slug);

    onProgress?.('web-build', `bundling static site (engine root: ${friendlyPath(engineRoot)}) …`);
    const bunBin = process.execPath || 'bun';
    try {
      mkdirSync(exportTmpDir, { recursive: true });
      cpSync(scriptSrc, scriptDst);
      mkdirSync(join(exportTmpDir, 'games'), { recursive: true });
      cpSync(gameDir, gameDst, { recursive: true, dereference: true });

      const proc = Bun.spawn({
        cmd: [bunBin, scriptDst, slug, outDir],
        cwd: engineRoot,
        env: { ...process.env, FORGEAX_ENGINE_ROOT: engineRoot, FORGEAX_GAME_DIR: gameDst },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const tailLog = (stderr || stdout).split('\n').slice(-40).join('\n');
        onProgress?.('web-build', `build failed (exit ${code}):\n${tailLog}`);
        return { ok: false, slug, platform: 'web', error: 'standalone build failed', detail: tailLog };
      }
      onProgress?.('web-build', 'done');
      return {
        ok: true,
        slug,
        platform: 'web',
        outDir: friendlyPath(outDir),
        rebuiltEngine: !!rebuildEngine,
        runHint: `cd ${friendlyPath(outDir)} && ./serve.sh   # then open http://localhost:8123`,
      };
    } catch (e) {
      return { ok: false, slug, platform: 'web', error: e instanceof Error ? e.message : String(e) };
    } finally {
      rmSync(exportTmpDir, { recursive: true, force: true });
    }
  }

  /** Reel (interactive-film) export — uses the legacy reel-src path as-is. */
  private async buildReel(args: {
    slug: string;
    outDir: string;
    root: string;
    onProgress?: (phase: string, line?: string) => void;
  }): Promise<PackageResult> {
    const { slug, outDir, root, onProgress } = args;
    const buildSrc = resolve(root, 'packages/build/reel-src');
    const scriptRel = 'export/build-reel-standalone.ts';

    if (!existsSync(resolve(buildSrc, scriptRel))) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: `export build script not found (packages/build/reel-src/${scriptRel})`,
      };
    }

    onProgress?.('web-build', 'bundling reel site …');
    const bunBin = process.execPath || 'bun';
    try {
      const proc = Bun.spawn({
        cmd: [bunBin, scriptRel, slug, outDir],
        cwd: buildSrc,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const tailLog = (stderr || stdout).split('\n').slice(-40).join('\n');
        onProgress?.('web-build', `build failed (exit ${code}):\n${tailLog}`);
        return { ok: false, slug, platform: 'web', error: 'standalone build failed', detail: tailLog };
      }
      onProgress?.('web-build', 'done');
      return {
        ok: true,
        slug,
        platform: 'web',
        outDir: friendlyPath(outDir),
        runHint: `cd ${friendlyPath(outDir)} && ./serve.sh   # then open http://localhost:8123`,
      };
    } catch (e) {
      return { ok: false, slug, platform: 'web', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private looksLikeEngineRoot(dir: string): boolean {
    return (
      existsSync(join(dir, 'node_modules', 'vite')) &&
      existsSync(join(dir, 'pack-catalog.ts')) &&
      existsSync(join(dir, 'src', 'types.ts'))
    );
  }
}
