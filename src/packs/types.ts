/**
 * Phase D7 — `.fxpack` portability format.
 *
 * Schema for `manifest.fxpack.json` (the bundle metadata, NOT to be confused
 * with each plugin's own `forgeax-plugin.json`). Source of truth:
 * `docs/v2-vision/architecture-evolution/10-FXPACK-PORTABILITY.md` §2.
 *
 * Mirrored as a zod schema in this file so importer/exporter can validate
 * round-trips. We keep this co-located with the packs module rather than
 * pushing into `@forgeax/types` because (a) only the server consumes it,
 * (b) the schema may shift faster than the cross-cutting types package.
 */
import { z } from 'zod';

export const FxpackBundleTypeSchema = z.enum(['single', 'bundle']);

export const FxpackI18nSchema = z.object({
  zh: z.string().optional(),
  en: z.string().optional(),
});

export const FxpackContainsEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  version: z.string().min(1),
});

export const FxpackRequiresSchema = z
  .object({
    forgeax: z.string().optional(),
    models: z.array(z.string()).optional(),
    vendors: z.array(z.string()).optional(),
  })
  .optional();

export const FxpackAuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
    publicKey: z.string().optional(),
  })
  .optional();

export const FxpackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  type: FxpackBundleTypeSchema,
  id: z.string().min(1),
  version: z.string().min(1),
  title: FxpackI18nSchema,
  description: FxpackI18nSchema.optional(),
  primary: z.string().optional(),
  contains: z.array(FxpackContainsEntrySchema).min(1),
  requires: FxpackRequiresSchema,
  author: FxpackAuthorSchema,
  createdAt: z.string().min(1),
});

export type FxpackManifest = z.infer<typeof FxpackManifestSchema>;

export const FxpackSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  publicKey: z.string().min(1),
  signedAt: z.string().min(1),
  signature: z.string().min(1),
  files: z.record(z.string(), z.string()),
});

export type FxpackSignature = z.infer<typeof FxpackSignatureSchema>;

/** Trust descriptor surfaced by `inspectPack` — what the UI's trust panel
 *  would render before the user confirms install. Per 10 §5.2 step 4. */
export interface FxpackTrustDescriptor {
  /** True if `signature.json` was present AND verified against the embedded
   *  public key. (Verification is in `signing.ts`; trust on top of that is
   *  decided by the trusted-keys.yaml lookup below.) */
  signed: boolean;
  /** Public key that signed the pack, if any. */
  publicKey?: string;
  /** trusted-keys.yaml verdict for the signing key:
   *    'trusted' — explicitly allowlisted, UI can skip the unsigned warning.
   *    'unknown' — signature valid but key not on file (default for OSS).
   *    'revoked' — explicitly blocklisted, UI must hard-block install.
   *  Absent when the pack is unsigned or the signature itself is invalid. */
  signerTrust?: 'trusted' | 'unknown' | 'revoked';
  /** Human-readable label from trusted-keys.yaml (when match found). */
  signerLabel?: string;
  /** Whether the trust verdict came from `<projectRoot>/.forgeax/...` or
   *  from the user-home fallback. */
  signerTrustSource?: 'project' | 'user' | 'none';
  /** Per-plugin permission strings, gathered from each plugin's manifest.
   *  Keyed by plugin id. */
  permissions: Record<string, string[]>;
  /** Existing-vs-new id collisions detected against the current PluginRegistry
   *  snapshot. Empty when no conflicts. */
  conflicts: Array<{
    id: string;
    existingLayer: 'L0' | 'L1' | 'L2';
    existingVersion: string;
    newVersion: string;
  }>;
  /** Soft warnings (unsigned, no README, native binaries scrubbed, etc.) */
  warnings: string[];
}

export interface FxpackExportInput {
  /** plugins to bundle; srcDir must point at the plugin's root (containing
   *  forgeax-plugin.json). */
  plugins: Array<{ id: string; srcDir: string }>;
  type: 'single' | 'bundle';
  /** bundle metadata; required for bundle, used as fallback for single. */
  bundleMeta: {
    id: string;
    version: string;
    title: { zh?: string; en?: string };
    description?: { zh?: string; en?: string };
    primary?: string;
    requires?: FxpackManifest['requires'];
    author?: FxpackManifest['author'];
  };
  /** Where to write the resulting .fxpack file. */
  outPath: string;
  /** When true, expand `plugins[]` to include the transitive
   *  `manifest.dependencies` closure resolved against the live PluginRegistry
   *  snapshot. Implicit for `type==='bundle'` (which has always done this);
   *  exposing the flag lets `type==='single'` bundles opt in too — useful
   *  when the receiver is offline and cannot install deps separately. */
  closure?: boolean;
  /** Optional ed25519 signing material. When omitted the pack ships unsigned
   *  (the doc allows this for OSS friendliness; the receiver's trust panel
   *  still labels it "未签名"). */
  signWith?: {
    /** PEM-encoded PKCS8 ed25519 private key. */
    privateKey: string;
    /** PEM-encoded SPKI ed25519 public key. */
    publicKey: string;
    /** Override signedAt (rare — only for deterministic tests). */
    signedAt?: string;
  };
}

export type FxpackExportResult =
  | { ok: true; path: string; manifest: FxpackManifest; warnings: string[] }
  | { ok: false; code: 'lint_error' | 'zip_error' | 'fs_error' | 'bad_input'; error: string; details?: unknown };

export interface FxpackInspectResult {
  ok: true;
  manifest: FxpackManifest;
  trust: FxpackTrustDescriptor;
}

export type FxpackInspectFailure = {
  ok: false;
  code: 'unzip_error' | 'manifest_invalid' | 'manifest_missing' | 'fs_error' | 'bad_input';
  error: string;
  details?: unknown;
};

/** Optional trust-lookup overrides for inspect/install. */
export interface FxpackTrustLookup {
  /** Project root for project-scoped trusted-keys.yaml. */
  projectRoot?: string;
  /** User home override (for tests). Defaults to os.homedir(). */
  homeDir?: string;
}

export interface FxpackInspectInput {
  zipPath: string;
  trustLookup?: FxpackTrustLookup;
}

export interface FxpackInstallInput {
  zipPath: string;
  /** Where to install. We always write under <destRoot>/.forgeax/plugins/<id>/ */
  destRoot: string;
  trustLookup?: FxpackTrustLookup;
  /** L1 (~/.forgeax/plugins) is the default; L2 picks <projectRoot>/.forgeax. */
  destLayer: 'L1' | 'L2';
  /** What to do when an id already exists at destRoot.
   *  - 'skip'      : leave the existing copy, drop the new one
   *  - 'overwrite' : nuke + replace (the doc reserves this for explicit confirm)
   *  - 'rename'    : install new copy under a `<id>-<timestamp>` slug
   *  default: 'skip' (the doc's "保留旧版"). */
  conflictPolicy?: 'skip' | 'overwrite' | 'rename';
  /** TrustPanel sets this when the user ticks "I acknowledge this pack is
   *  unsigned and I want to install anyway". On a successful install we
   *  append a plugins-trust.yaml entry so the next install of the same id
   *  can skip the warning (see 10 §plugins-trust.yaml). For signed packs the
   *  flag is harmless: no trust ack is written because none is needed. */
  userAcknowledgedUnsigned?: boolean;
}

export type FxpackInstallResult =
  | { ok: true; installed: string[]; skipped: string[]; renamed: Record<string, string> }
  | { ok: false; code: 'install_error' | 'fs_error' | 'inspect_failed' | 'bad_input'; error: string; details?: unknown };
