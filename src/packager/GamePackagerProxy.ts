/**
 * Proxy (design-pattern sense) for {@link IGamePackager}.
 *
 * Cross-cutting, platform-agnostic responsibilities:
 *   - validate PackageOptions (slug format, gameDir existence)
 *   - wall-clock timing + structured logging
 *   - exception barrier — never let an uncaught throw leak to the API layer
 */

import { existsSync } from 'node:fs';
import type { IGamePackager, PackageOptions, PackageResult } from './IGamePackager';

export class GamePackagerProxy implements IGamePackager {
  constructor(private readonly delegate: IGamePackager) {}

  get platform() {
    return this.delegate.platform;
  }

  async build(opts: PackageOptions): Promise<PackageResult> {
    // ── 1. param validation ──
    if (!opts.slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(opts.slug)) {
      return { ok: false, slug: opts.slug, platform: opts.platform, error: 'invalid slug' };
    }
    if (!existsSync(opts.gameDir)) {
      return {
        ok: false,
        slug: opts.slug,
        platform: opts.platform,
        error: `.forgeax/games/${opts.slug} not found`,
      };
    }

    // ── 2. delegate + timing ──
    const t0 = performance.now();
    console.log(`[packager] starting ${opts.platform} build for "${opts.slug}"…`);

    try {
      const result = await this.delegate.build(opts);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      if (result.ok) {
        console.log(`[packager] ${opts.platform} build for "${opts.slug}" done in ${elapsed}s → ${result.outDir}`);
      } else {
        console.error(`[packager] ${opts.platform} build for "${opts.slug}" failed after ${elapsed}s: ${result.error}`);
      }
      return result;
    } catch (e) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[packager] ${opts.platform} build for "${opts.slug}" threw after ${elapsed}s: ${msg}`);
      return { ok: false, slug: opts.slug, platform: opts.platform, error: msg };
    }
  }
}
