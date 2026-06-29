/**
 * Windows platform packager — produces a standalone game folder with
 * a reusable launcher exe + `_web/` site.
 *
 * Strategy:
 *   1. ShellProvider: build (or retrieve from cache) the universal launcher
 *      via `bun build --compile`.  No Rust required.
 *   2. WebPackager: generate the static site into `_web/`.
 *   3. Copy the launcher exe + write config + record history.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { IGamePackager, PackageOptions, PackageResult } from '../IGamePackager';
import { friendlyPath } from '@forgeax/platform-io';
import { WebPackager } from './WebPackager';
import { getOrBuildShell } from '../shell/ShellProvider';
import { appendHistory } from '../history';

export class WindowsPackager implements IGamePackager {
  readonly platform = 'windows' as const;
  private webPackager = new WebPackager();

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, projectRoot, onProgress, forceRebuild } = opts;
    const t0 = Date.now();
    const winOutDir = resolve(projectRoot, '.forgeax/exports', `${slug}-windows`);
    const webOutDir = resolve(winOutDir, '_web');
    const cacheDir = join(homedir(), '.forgeax', 'cache');

    if (forceRebuild && existsSync(winOutDir)) {
      onProgress?.('cleanup', 'cleaning previous build …');
      rmSync(winOutDir, { recursive: true, force: true });
    }

    // Step 1: acquire the launcher exe
    onProgress?.('shell', 'acquiring launcher shell …');
    const shell = await getOrBuildShell(cacheDir, onProgress, forceRebuild);
    if (!shell.ok || !shell.exePath) {
      const rec = appendHistory({
        slug,
        platform: 'windows',
        status: 'failed',
        durationMs: Date.now() - t0,
        error: shell.error ?? 'shell build failed',
      });
      return {
        ok: false, slug, platform: 'windows',
        error: shell.error ?? 'failed to build launcher shell',
        detail: `history: ${rec.id}`,
      };
    }

    // Step 2: web build (with optional engine rebuild)
    onProgress?.('web-build', 'building web artefacts …');
    const webResult = await this.webPackager.build({
      ...opts,
      outDir: webOutDir,
    });
    if (!webResult.ok) {
      appendHistory({
        slug,
        platform: 'windows',
        status: 'failed',
        durationMs: Date.now() - t0,
        error: webResult.error,
        usedCachedShell: shell.cached,
        rebuiltEngine: webResult.rebuiltEngine,
      });
      return { ...webResult, platform: 'windows' };
    }

    // Step 3: assemble
    onProgress?.('assemble', 'assembling Windows package …');
    mkdirSync(winOutDir, { recursive: true });

    const exeName = this.sanitizeExeName(slug) + '.exe';
    cpSync(shell.exePath, join(winOutDir, exeName));

    const gameName = this.readGameName(gameDir, slug);
    writeFileSync(
      join(winOutDir, 'forgeax-player.json'),
      JSON.stringify({ title: gameName, webRoot: './_web', port: 0 }),
    );

    const outDirFriendly = friendlyPath(winOutDir);
    const durationMs = Date.now() - t0;

    appendHistory({
      slug,
      platform: 'windows',
      status: 'success',
      durationMs,
      outDir: outDirFriendly,
      usedCachedShell: shell.cached,
      rebuiltEngine: webResult.rebuiltEngine,
    });

    onProgress?.('done', `packaged in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      ok: true,
      slug,
      platform: 'windows',
      outDir: outDirFriendly,
      runHint: `Double-click ${exeName} in ${outDirFriendly}`,
      usedCachedShell: shell.cached,
      rebuiltEngine: webResult.rebuiltEngine,
    };
  }

  private readGameName(gameDir: string, fallback: string): string {
    try {
      const forge = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf-8')) as { name?: string };
      return forge.name ?? fallback;
    } catch {
      return fallback;
    }
  }

  private sanitizeExeName(slug: string): string {
    return slug.replace(/[^a-z0-9-]/g, '-');
  }
}
