// Locate marketplace/manifest.json across the supported deployment layouts.
//
// Probe order (first existing wins):
//   1. packages/marketplace under projectRoot (studio dev mode: projectRoot=studio root)
//   2. ../packages/marketplace (release mode: projectRoot=packages/<name>)
//   3. Legacy flat layouts (../marketplace, etc.) for older / non-submodule deploys.
//   4. Host-bundled assetRoot()/marketplace — fallback for the packaged .app
//      (user-workspace projectRoot has no packages/marketplace there).
//
// Instance/workspace (projectRoot) wins over the host-bundled copy so dev and
// tests resolve their own manifest. Centralized so /agents and /events/recent
// can't drift out of sync.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { friendlyPath } from './friendly-path';
import { assetRoot } from '../../lib/asset-root';

export function marketplaceManifestCandidates(projectRoot: string): string[] {
  return [
    // Instance/workspace manifest wins: the projectRoot-relative layouts are
    // the authoritative source in dev (projectRoot=studio root) and let tests
    // / overrides point at their own manifest.
    resolve(projectRoot, 'packages/marketplace/manifest.json'),
    resolve(projectRoot, '../packages/marketplace/manifest.json'),
    resolve(projectRoot, '../../packages/marketplace/manifest.json'),
    resolve(projectRoot, 'marketplace/manifest.json'),
    resolve(projectRoot, '../marketplace/manifest.json'),
    resolve(projectRoot, '../../marketplace/manifest.json'),
    // Host-bundled marketplace as the fallback. assetRoot() = `packages/` in
    // dev (== the first probe), `<Resources>/resources/` in the packaged .app
    // where projectRoot (user workspace) has no packages/marketplace — so this
    // is what the packaged app actually resolves to.
    resolve(assetRoot(), 'marketplace/manifest.json'),
  ];
}

export interface FoundManifest {
  path: string;
  triedFriendly: string[];
}

/**
 * Find the first existing marketplace/manifest.json among the supported
 * layouts. Returns `undefined` and the friendly-path list of probed
 * locations if none exist (caller decides how to surface the miss).
 */
export function findMarketplaceManifest(projectRoot: string): FoundManifest | { path: undefined; triedFriendly: string[] } {
  const candidates = marketplaceManifestCandidates(projectRoot);
  const path = candidates.find((p) => existsSync(p));
  if (path) return { path, triedFriendly: candidates.map((p) => friendlyPath(p)) };
  return { path: undefined, triedFriendly: candidates.map((p) => friendlyPath(p)) };
}
