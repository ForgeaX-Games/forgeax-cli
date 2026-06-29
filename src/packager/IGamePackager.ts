/**
 * Subject interface for the cross-platform game packager.
 *
 * Each platform packager (Web, Windows, Android, iOS, ...) implements this
 * interface. The {@link GamePackagerProxy} wraps any concrete packager to add
 * validation, logging, timing without touching platform-specific build logic.
 */

export type TargetPlatform = 'web' | 'windows' | 'android' | 'ios';

export interface PackageOptions {
  slug: string;
  /** Absolute path to .forgeax/games/<slug>/ */
  gameDir: string;
  /** Absolute path to the monorepo / workspace root */
  projectRoot: string;
  /** Where to write the final artefacts */
  outDir: string;
  platform: TargetPlatform;
  /** Selected engine root (play-runtime). When unset, WebPackager auto-detects. */
  engineRoot?: string;
  /** Rebuild the Rust→WASM engine core before bundling (wgpu-wasm/build.sh) */
  rebuildEngine?: boolean;
  /** Clear related caches and retry from scratch */
  forceRebuild?: boolean;
  /** Progress callback — Strategy reports phases/lines, API layer feeds them to Job */
  onProgress?: (phase: string, line?: string) => void;
}

export interface PackageResult {
  ok: boolean;
  slug: string;
  platform: TargetPlatform;
  outDir?: string;
  /** Human-friendly run hint (e.g. `./serve.sh` or the .exe path) */
  runHint?: string;
  /** Whether the cached launcher shell was reused (Windows) */
  usedCachedShell?: boolean;
  /** Whether the engine WASM core was rebuilt this run */
  rebuiltEngine?: boolean;
  error?: string;
  detail?: string;
}

export interface IGamePackager {
  readonly platform: TargetPlatform;
  build(opts: PackageOptions): Promise<PackageResult>;
}
