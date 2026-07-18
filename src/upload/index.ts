// Upload orchestration: dry-run plan (with confirm nonce) → confirmed push.
//
// Human-as-final-authority is enforced on a path the UI can actually reach (the v1
// design leaned on a /query dry-run that Composer.tsx / store.ts never call):
//   planUpload()      → returns the plan + a short-lived nonce, pushes nothing
//   uploadWorkspace() → requires that nonce, then pushes
//
// Fail-closed: the secret scan runs in BOTH planUpload (to show the user) and
// uploadWorkspace (the real gate) — a plan can never authorize a push that ships
// secrets, even if the tree changed between plan and confirm.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  loadUploadConfig,
  resolvePlanContext,
  uploadLogFile,
  UploadConfigError,
  type PlanContext,
} from "./config";
import {
  scanFilesForSecrets,
  sensitiveEnvLiterals,
  walkUploadTree,
  type SecretHit,
} from "./manifest";
import {
  githubAuthHeader,
  githubRemoteUrl,
  pushSubset,
  snapshotDirName,
  GitUploadError,
  type GitErrorKind,
} from "./git-uploader";
import { buildUploadArchive, UploadArchiveError } from "./archive";

export type UploadErrorKind =
  | "no-repo"
  | "secret-detected"
  | "bad-nonce"
  | "archive-too-large"
  | "archive-failed"
  | GitErrorKind;

export interface UploadPlan {
  ok: true;
  kind: "plan";
  namespace: string;
  repo: string;
  branch: string;
  fileCount: number;
  bytes: number;
  skippedSymlinks: { rel: string; target: string }[];
  skippedLarge: { rel: string; bytes: number }[];
  secretHits: SecretHit[];
  tokenConfigured: boolean;
  /** Present only when an effective credential exists and the plan is safe. */
  nonce?: string;
  summary: string;
}

export interface UploadResult {
  ok: true;
  kind: "result";
  namespace: string;
  repoUrl: string;
  branch: string;
  /** repo-relative snapshot path the content lives in, e.g. `<ns>/data/<ts>`. */
  path: string;
  commit: string;
  /** Git files changed (workspace.tar.gz + manifest.json for a new snapshot). */
  filesChanged: number;
  sourceFileCount: number;
  sourceBytes: number;
  archiveBytes: number;
  /** @deprecated alias for sourceBytes retained only inside the current UI contract. */
  bytes: number;
  skipped: boolean;
  summary: string;
}

export interface UploadFailure {
  ok: false;
  kind: UploadErrorKind;
  error: string;
}

export type UploadOutcome = UploadPlan | UploadResult | UploadFailure;

interface NonceEntry {
  /** the workspace the plan was made for — confirm re-checks it, so a nonce can
   *  never authorize pushing a different workspace than the one the user saw. */
  namespace: string;
  ts: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map<string, NonceEntry>();

// Per-namespace serialization so concurrent /upload (or a UI double-click) on one
// machine can't interleave clones/commits. Keyed promise chain.
const chains = new Map<string, Promise<unknown>>();
function withNamespaceLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(namespace) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    namespace,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function configFailure(e: UploadConfigError): UploadFailure {
  return { ok: false, kind: e.kind, error: e.message };
}

// ── plan (dry-run) ───────────────────────────────────────────────────────────

export interface PlanOpts {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function planUpload(opts: PlanOpts = {}): UploadPlan | UploadFailure {
  let ctx: PlanContext;
  try {
    ctx = resolvePlanContext(opts);
  } catch (e) {
    if (e instanceof UploadConfigError) return configFailure(e);
    throw e;
  }

  const walk = walkUploadTree(ctx.sourceRoot);
  const literals = sensitiveEnvLiterals(opts.env ?? process.env);
  const secretHits = scanFilesForSecrets(walk.files, literals);

  // Sweep expired nonces so abandoned plans can't accumulate.
  for (const [k, v] of nonces) if (Date.now() - v.ts > NONCE_TTL_MS) nonces.delete(k);

  const safe = ctx.tokenConfigured && secretHits.length === 0 && walk.files.length > 0;
  let nonce: string | undefined;
  if (safe) {
    nonce = randomBytes(9).toString("hex");
    nonces.set(nonce, { namespace: ctx.namespace, ts: Date.now() });
  }

  const lines: string[] = [];
  lines.push(`Upload plan for ${ctx.namespace} → ${ctx.repo}@${ctx.branch}`);
  lines.push(`  ${walk.files.length} files, ${fmtBytes(walk.totalBytes)}`);
  if (walk.skippedSymlinks.length) lines.push(`  skipped ${walk.skippedSymlinks.length} symlinked dir(s) (monorepo samples)`);
  if (walk.skippedLarge.length) lines.push(`  skipped ${walk.skippedLarge.length} oversized file(s)`);
  if (secretHits.length) lines.push(`  ✋ ${secretHits.length} secret(s) detected — upload blocked (see secretHits)`);
  if (walk.files.length === 0) lines.push(`  ⚠ nothing to upload`);
  if (nonce) lines.push(`  → run: /upload confirm ${nonce}`);

  return {
    ok: true,
    kind: "plan",
    namespace: ctx.namespace,
    repo: ctx.repo,
    branch: ctx.branch,
    fileCount: walk.files.length,
    bytes: walk.totalBytes,
    skippedSymlinks: walk.skippedSymlinks,
    skippedLarge: walk.skippedLarge,
    secretHits,
    tokenConfigured: ctx.tokenConfigured,
    nonce,
    summary: lines.join("\n"),
  };
}

// ── confirmed upload ─────────────────────────────────────────────────────────

export interface UploadOpts {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** test seam — override the git remote (e.g. a local bare repo path). */
  remoteUrlOverride?: string;
  sleep?: (ms: number) => Promise<void>;
}

function appendLog(projectRoot: string, entry: Record<string, unknown>): void {
  try {
    const file = uploadLogFile(projectRoot);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* audit log is best-effort; never block the upload on it */
  }
}

export async function uploadWorkspace(nonce: string, opts: UploadOpts = {}): Promise<UploadResult | UploadFailure> {
  // Validate nonce against a recent plan (human-as-final-authority gate).
  const entry = nonce ? nonces.get(nonce) : undefined;
  if (!entry || Date.now() - entry.ts > NONCE_TTL_MS) {
    if (nonce) nonces.delete(nonce);
    return { ok: false, kind: "bad-nonce", error: "no recent plan for this confirmation — run /upload first" };
  }
  nonces.delete(nonce); // single-use

  let cfg;
  try {
    cfg = loadUploadConfig(opts);
  } catch (e) {
    if (e instanceof UploadConfigError) return configFailure(e);
    throw e;
  }

  if (entry.namespace !== cfg.namespace) {
    return {
      ok: false,
      kind: "bad-nonce",
      error: "this confirmation was planned for a different workspace — run /upload again",
    };
  }

  return withNamespaceLock(cfg.namespace, async () => {
    // Re-walk at execute time (the tree may have changed since the plan). Archive
    // construction below reads every file once and performs the execute-time secret
    // scan on those exact bytes before anything reaches Git.
    const walk = walkUploadTree(cfg.sourceRoot);
    const literals = sensitiveEnvLiterals(opts.env ?? process.env);
    if (walk.files.length === 0) {
      return { ok: false as const, kind: "empty-set" as const, error: "nothing to upload" };
    }

    // One snapshot dir + one commit per upload = one restorable, time-named
    // version; timestamp in the message so the GitHub history reads the same way.
    const snapshotDir = snapshotDirName();
    const commitMessage = `upload: ${cfg.namespace} @ ${new Date().toISOString()}`;
    const remoteUrl = opts.remoteUrlOverride ?? githubRemoteUrl(cfg.repo);
    const authHeader = opts.remoteUrlOverride ? undefined : githubAuthHeader(cfg.token);

    appendLog(cfg.projectRoot, {
      namespace: cfg.namespace,
      outcome: "started",
      files: walk.files.length,
      bytes: walk.totalBytes,
    });

    let archive;
    try {
      archive = await buildUploadArchive(walk.files, { literals });
      if (archive.secretHits.length > 0) {
        appendLog(cfg.projectRoot, { namespace: cfg.namespace, outcome: "secret-detected", hits: archive.secretHits.length });
        return {
          ok: false as const,
          kind: "secret-detected" as const,
          error: `upload blocked — ${archive.secretHits.length} secret(s) detected in: ${archive.secretHits
            .slice(0, 3)
            .map((h) => h.rel)
            .join(", ")}`,
        };
      }

      const res = await pushSubset({
        remoteUrl,
        authHeader,
        branch: cfg.branch,
        namespace: cfg.namespace,
        snapshotDir,
        archive,
        commitMessage,
        sleep: opts.sleep,
      });
      const repoUrl = `https://github.com/${cfg.repo}`;
      const summary = res.skipped
        ? `Nothing changed since the last snapshot (${res.path}) — no new version created.`
        : `Uploaded ${res.sourceFileCount} files as ${fmtBytes(res.archiveBytes)} archive (${fmtBytes(res.sourceBytes)} raw) to ${repoUrl}/tree/${cfg.branch}/${res.path} @ ${res.commit.slice(0, 7)}`;
      appendLog(cfg.projectRoot, {
        namespace: cfg.namespace,
        outcome: res.skipped ? "skipped" : "completed",
        commit: res.commit,
        path: res.path,
        sourceFiles: res.sourceFileCount,
        sourceBytes: res.sourceBytes,
        archiveBytes: res.archiveBytes,
        gitFiles: res.filesChanged,
      });
      return {
        ok: true as const,
        kind: "result" as const,
        namespace: cfg.namespace,
        repoUrl,
        branch: cfg.branch,
        path: res.path,
        commit: res.commit,
        filesChanged: res.filesChanged,
        sourceFileCount: res.sourceFileCount,
        sourceBytes: res.sourceBytes,
        archiveBytes: res.archiveBytes,
        bytes: res.sourceBytes,
        skipped: res.skipped,
        summary,
      };
    } catch (e) {
      const err = e instanceof GitUploadError || e instanceof UploadArchiveError
        ? e
        : new GitUploadError("git-failed", String((e as Error)?.message ?? e));
      appendLog(cfg.projectRoot, { namespace: cfg.namespace, outcome: "failed", kind: err.kind, error: err.message });
      return { ok: false as const, kind: err.kind, error: err.message };
    } finally {
      archive?.cleanup();
    }
  });
}

// ── audit log read side ──────────────────────────────────────────────────────

export function tailUploadLog(opts: { projectRoot?: string; limit?: number } = {}): { ok: true; entries: unknown[] } {
  const file = uploadLogFile(opts.projectRoot);
  const limit = opts.limit ?? 10;
  if (!existsSync(file)) return { ok: true, entries: [] };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
  return { ok: true, entries };
}
