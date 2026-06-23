/**
 * Brand pack — shared TypeScript shape.
 *
 * Mirrors `brand/schema.json`. The interface module re-uses these types via
 * structural copy (no cross-package import — interface is its own vite
 * project). If you change a field here, also update:
 *
 *   - brand/schema.json
 *   - brand/defaults.forgeax.json
 *   - packages/interface/src/brand/types.ts
 *
 * See docs/decisions/0006-rebrand-to-forgeax.md and
 * docs/features/full-rebrand-to-forgeax.md §5.2.
 */

export const BRAND_SCHEMA_VERSION = 1 as const;

export type SplashThemeId = 'classic-lime' | 'neon-pulse';

export interface BrandConfig {
  id: string;
  schemaVersion: typeof BRAND_SCHEMA_VERSION;
  product: {
    name: string;
    shortName: string;
    tagline: string;
  };
  assistant: {
    name: string;
    avatarSrc?: string | null;
    personaOverride?: {
      zh?: string | null;
      en?: string | null;
    };
    cardName?: {
      zh?: string;
      en?: string;
    };
  };
  splash: {
    title: string;
    subtitle: string;
    theme: SplashThemeId;
  };
  providers: {
    native: {
      id: string;
      label: string;
      title: string;
    };
  };
  links: {
    repoUrl: string;
    communityUrl: string;
    docsUrl?: string | null;
    issuesUrl?: string | null;
  };
  assets?: {
    favicon?: string | null;
    logo?: string | null;
    appleTouchIcon?: string | null;
  };
}

export type BrandSource =
  | { kind: 'env'; name: string }            // FORGEAX_BRAND
  | { kind: 'symlink'; target: string }       // brand/active → defaults.<id>
  | { kind: 'default' }
  | { kind: 'override-dir'; dir: string };    // explicit FORGEAX_BRAND_DIR (tests)

export interface BrandResolution {
  config: BrandConfig;
  source: BrandSource;
  /** Absolute path to the pack root (the dir containing `assets/`). */
  packDir: string;
  /** Absolute path to the manifest JSON. */
  manifestPath: string;
  /** Absolute path to the brand registry dir (the parent of `defaults.*.json`). */
  brandRoot: string;
}
