/**
 * PackagerRegistry — factory that maps a {@link TargetPlatform} to a
 * proxy-wrapped {@link IGamePackager} implementation.
 *
 * Adding a new platform is one line:
 *   `registry.register(new AndroidPackager());`
 */

export { type TargetPlatform, type PackageOptions, type PackageResult, type IGamePackager } from './IGamePackager';
export { GamePackagerProxy } from './GamePackagerProxy';
export { listHistory, deleteHistory } from './history';
export { cleanPackagingEnv, type CleanReport, type CleanedTarget } from './clean';
export { createJob, getJob, updateJob, makeProgressFn, type JobRecord, type JobStatus } from './jobs';
export { detectEngineRoots, recommendedEngineRoot, type EngineRootCandidate } from './engine-roots';

import type { IGamePackager, TargetPlatform, PackageOptions, PackageResult } from './IGamePackager';
import { GamePackagerProxy } from './GamePackagerProxy';
import { WebPackager } from './platforms/WebPackager';
import { WindowsPackager } from './platforms/WindowsPackager';

class PackagerRegistry {
  private packagers = new Map<TargetPlatform, IGamePackager>();

  register(packager: IGamePackager): void {
    this.packagers.set(packager.platform, new GamePackagerProxy(packager));
  }

  get supportedPlatforms(): TargetPlatform[] {
    return [...this.packagers.keys()];
  }

  has(platform: TargetPlatform): boolean {
    return this.packagers.has(platform);
  }

  async build(opts: PackageOptions): Promise<PackageResult> {
    const packager = this.packagers.get(opts.platform);
    if (!packager) {
      return {
        ok: false,
        slug: opts.slug,
        platform: opts.platform,
        error: `unsupported platform: "${opts.platform}". Supported: ${this.supportedPlatforms.join(', ')}`,
      };
    }
    return packager.build(opts);
  }
}

/** Singleton registry with all currently-supported platforms. */
const registry = new PackagerRegistry();
registry.register(new WebPackager());
registry.register(new WindowsPackager());

export { registry };
