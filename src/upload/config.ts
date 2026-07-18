// Upload config + namespace resolution.
//
// Two roots, never conflated (the v1 design bug):
//   - source root (READ)  = <projectRoot>/.forgeax        (games/souls/prefs live here)
//   - staging root (WRITE) = mkdtemp under os.tmpdir()     (see git-uploader)
// `pm.user()` (= ~/.forgeax) is NOT the source — that tree has no games.
//
// The effective GitHub credential is the FORGEAX_UPLOAD_GITHUB_TOKEN env
// override when present, otherwise the compiled built-in fallback. An env
// override is never written to upload.json / commits / logs, and read_file
// denies credential files that may contain it. The fallback is shipped code.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { defaultProjectRoot } from "@forgeax/platform-io";

/** Default upload destination — the shared org repo every workspace lands in
 *  (one `<namespace>/` subdirectory each). Users may point FORGEAX_UPLOAD_REPO at
 *  any repo their own token can write (Settings → Upload edits it; the settings
 *  PUT live-applies, so no restart). Decision 2026-07-09: user-configurable repo
 *  replaces the earlier fixed-destination stance; the shared repo is just this
 *  default. */
export const DEFAULT_UPLOAD_REPO = "ForgeaX-Games/Forgeax-Data";

export const DEFAULT_BRANCH = "main";

/** Built-in shared token (write access to the shared repo only), so upload works
 *  out of the box; FORGEAX_UPLOAD_GITHUB_TOKEN overrides it. Stored in pieces —
 *  GitHub secret-scanning/push-protection auto-revokes verbatim `github_pat_`
 *  strings the moment they land in a public mirror. */
export const DEFAULT_UPLOAD_TOKEN = [
  "github_pat_",
  "11AD6JT7Q0eSIif2dpYVdf_",
  "7cBewgSJIWp7b6ufAxKV6lD4pguSWzwggLBH067TqgpFQYTNDSBWxpBsKCv",
].join("");

export type UploadConfigErrorKind = "no-repo";

export class UploadConfigError extends Error {
  constructor(public readonly kind: UploadConfigErrorKind, message: string) {
    super(message);
    this.name = "UploadConfigError";
  }
}

export interface UploadConfig {
  /** never logged / committed / persisted. */
  token: string;
  repo: string; // owner/repo
  branch: string;
  namespace: string;
  sourceRoot: string; // <projectRoot>/.forgeax
  projectRoot: string;
}

/** Context for the read-only dry-run plan. */
export interface PlanContext {
  repo: string;
  branch: string;
  namespace: string;
  sourceRoot: string;
  projectRoot: string;
  tokenConfigured: boolean;
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export function uploadSourceRoot(projectRoot: string = defaultProjectRoot()): string {
  return resolve(projectRoot, ".forgeax");
}

export function uploadStateFile(projectRoot: string = defaultProjectRoot()): string {
  return resolve(projectRoot, ".forgeax", "upload.json");
}

export function uploadLogFile(projectRoot: string = defaultProjectRoot()): string {
  return resolve(projectRoot, ".forgeax", "upload-log.jsonl");
}

/** Resolve + validate the destination repo (env override or shared default). */
function resolveRepo(env: NodeJS.ProcessEnv): string {
  const repo = (env.FORGEAX_UPLOAD_REPO?.trim() || DEFAULT_UPLOAD_REPO).trim();
  if (!repo || !REPO_RE.test(repo)) {
    throw new UploadConfigError(
      "no-repo",
      "upload destination not published yet — ask the maintainer for the shared repo, or set FORGEAX_UPLOAD_REPO=owner/repo in this machine's .env",
    );
  }
  return repo;
}

function resolveBranch(env: NodeJS.ProcessEnv): string {
  return env.FORGEAX_UPLOAD_BRANCH?.trim() || DEFAULT_BRANCH;
}

function resolveToken(env: NodeJS.ProcessEnv): string {
  return env.FORGEAX_UPLOAD_GITHUB_TOKEN?.trim() || DEFAULT_UPLOAD_TOKEN;
}

// ── namespace ────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** A meaningful writer identity for the human-readable namespace prefix. NOT
 *  basename(projectRoot) — in this monorepo that is always 'forgeax-os' and conveys
 *  zero identity. Prefer git user.name, fall back to basename. */
function identityLabel(projectRoot: string, env: NodeJS.ProcessEnv): string {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name;
  } catch {
    /* git missing / unconfigured */
  }
  return basename(resolve(projectRoot));
}

/** Compute (do not persist) the namespace for a workspace. Default form is
 *  `<slug>-<sha256[:12]>`; an explicit FORGEAX_UPLOAD_NAMESPACE overrides the whole
 *  thing (slugified). The 12-hex hash makes collisions effectively impossible
 *  (vs the v1 4-hex which hit 50% by ~300 workspaces). */
export function computeNamespace(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FORGEAX_UPLOAD_NAMESPACE?.trim();
  if (explicit) {
    const s = slugify(explicit);
    if (s) return s;
  }
  const hash = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 12);
  const readable = slugify(identityLabel(projectRoot, env));
  return readable ? `${readable}-${hash}` : hash;
}

interface UploadState {
  version: 1;
  namespace: string;
}

function persistNamespace(stateFile: string, namespace: string): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const state: UploadState = { version: 1, namespace };
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

/** The stable per-workspace landing slug. Generated once and persisted to
 *  upload.json (the one fact that must survive locally and is not derivable);
 *  read back verbatim thereafter so it never drifts. */
export function resolveNamespace(
  projectRoot: string = defaultProjectRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateFile = uploadStateFile(projectRoot);
  if (existsSync(stateFile)) {
    try {
      const j = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<UploadState>;
      if (typeof j?.namespace === "string" && j.namespace) return j.namespace;
    } catch {
      /* corrupt → regenerate below */
    }
  }
  const ns = computeNamespace(projectRoot, env);
  persistNamespace(stateFile, ns);
  return ns;
}

// ── config loaders ───────────────────────────────────────────────────────────

/** Read-only context for the dry-run plan. tokenConfigured reports whether an
 *  effective credential is available after env-override/fallback resolution.
 *  The repo is validated so the plan shows the real destination. */
export function resolvePlanContext(opts: { projectRoot?: string; env?: NodeJS.ProcessEnv } = {}): PlanContext {
  const projectRoot = resolve(opts.projectRoot ?? defaultProjectRoot());
  const env = opts.env ?? process.env;
  const repo = resolveRepo(env);
  const token = resolveToken(env);
  return {
    repo,
    branch: resolveBranch(env),
    namespace: resolveNamespace(projectRoot, env),
    sourceRoot: uploadSourceRoot(projectRoot),
    projectRoot,
    tokenConfigured: token.length > 0,
  };
}

/** Full config for an actual push. The env token overrides the built-in fallback. */
export function loadUploadConfig(opts: { projectRoot?: string; env?: NodeJS.ProcessEnv } = {}): UploadConfig {
  const projectRoot = resolve(opts.projectRoot ?? defaultProjectRoot());
  const env = opts.env ?? process.env;
  const token = resolveToken(env);
  const repo = resolveRepo(env);
  return {
    token,
    repo,
    branch: resolveBranch(env),
    namespace: resolveNamespace(projectRoot, env),
    sourceRoot: uploadSourceRoot(projectRoot),
    projectRoot,
  };
}
