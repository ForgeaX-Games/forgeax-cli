// The git push of a workspace snapshot into one namespace subtree.
//
// Remote layout:
//   <namespace>/data/<YYYY-MM-DD_HHMMSS>/workspace.tar.gz
//   <namespace>/data/<YYYY-MM-DD_HHMMSS>/manifest.json
// Every upload lands in a fresh timestamped snapshot directory — nothing is ever
// overwritten or deleted. Identical re-uploads are deduped by the manifest's
// canonical source-content hash.
//
// Design points (all driven by the adversarial review):
//   - remote-agnostic: pushSubset takes a remoteUrl + optional authHeader, so unit
//     tests drive it against a local bare repo (file path) with no network/auth.
//   - token in flight: injected via GIT_CONFIG_* env vars (NOT the remote URL — no
//     residue in .git/config; NOT argv — no `ps` visibility). Scrubbed from every
//     error surface.
//   - subprocess isolation: git spawned with an explicit minimal env, NOT inheriting
//     process.env (keeps ANTHROPIC_* etc. out), and with system/global gitconfig
//     neutralized — a developer's ~/.gitconfig routinely carries url.insteadOf
//     rewrites (would silently reroute the push over a personal SSH identity,
//     bypassing the injected token), credential helpers, and core.hooksPath
//     (ambient pre-push hooks block pushes to the shared repo's main).
//   - sparse partial clone: only the new snapshot dir is materialized — O(1)
//     working tree regardless of how many snapshots exist. --filter degrades to a
//     warning on local-path remotes (tests); sparse-checkout applies everywhere.
//   - non-fast-forward → bounded jittered backoff with fetch+rebase (disjoint
//     namespace subtrees never content-conflict).

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import {
  ARCHIVE_FILENAME,
  MANIFEST_FILENAME,
  parseUploadArchiveManifest,
  serializeUploadArchiveManifest,
  type UploadArchive,
} from "./archive";

export type GitErrorKind =
  | "no-git"
  | "offline"
  | "auth-failed"
  | "push-rejected"
  | "empty-set"
  | "git-failed";

export class GitUploadError extends Error {
  constructor(public readonly kind: GitErrorKind, message: string) {
    super(message);
    this.name = "GitUploadError";
  }
}

/** Snapshot directory name — local time, lexically sortable. */
export function snapshotDirName(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

export interface PushSubsetParams {
  remoteUrl: string;
  /** Full HTTP Authorization header value, e.g. "basic <b64>". Omit for file:// remotes. */
  authHeader?: string;
  branch: string;
  namespace: string;
  /** Timestamped snapshot directory this upload lands in (see snapshotDirName). */
  snapshotDir: string;
  archive: UploadArchive;
  commitMessage: string;
  committer?: { name: string; email: string };
  maxAttempts?: number; // push retry attempts, default 5
  sleep?: (ms: number) => Promise<void>; // injectable for tests
}

export interface PushSubsetResult {
  commit: string;
  /** Git paths staged by this snapshot (two for a new archive, zero when skipped). */
  filesChanged: number;
  sourceFileCount: number;
  sourceBytes: number;
  archiveBytes: number;
  skipped: boolean; // true when identical to the latest snapshot (no commit made)
  /** repo-relative path of the snapshot the content lives in (the previous one when skipped). */
  path: string;
}

const DEFAULT_COMMITTER = { name: "forgeax-upload", email: "upload@forgeax.local" };

/** Build the `Authorization` header value for a GitHub PAT over HTTPS. */
export function githubAuthHeader(token: string): string {
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `basic ${b64}`;
}

export function githubRemoteUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/** Redact the token / auth header from arbitrary text before it reaches a log/UI. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("[redacted]");
  }
  return out;
}

interface GitRunOpts {
  cwd: string;
  authHeader?: string;
  secrets: string[];
  timeoutMs?: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

async function git(args: string[], opts: GitRunOpts): Promise<string> {
  // Minimal explicit env — do NOT inherit process.env, and point global/system
  // config at the null device so ~/.gitconfig (insteadOf rewrites, credential
  // helpers, hooksPath) cannot alter transport or identity. The auth header rides
  // GIT_CONFIG_* env vars, never argv / the URL; credential.helper is cleared so
  // nothing ambient can answer (or capture) an auth exchange.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
  };
  // Proxy vars are legitimate transport config (many networks can't reach GitHub
  // directly) — pass them through; they carry no secrets of ours.
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const cfg: [string, string][] = [["credential.helper", ""]];
  if (opts.authHeader) cfg.push(["http.extraHeader", `AUTHORIZATION: ${opts.authHeader}`]);
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return await new Promise<string>((resolvePromise, reject) => {
    execFile("git", args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new GitUploadError("offline", `git timed out after ${Math.round(timeoutMs / 1000)}s — check your network`));
          return;
        }
        const raw = `${stderr || ""}${err.message || ""}`;
        const msg = scrub(raw, opts.secrets);
        reject(classifyGitError(msg, (err as NodeJS.ErrnoException).code));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

function classifyGitError(scrubbedMsg: string, code?: string): GitUploadError {
  if (code === "ENOENT") return new GitUploadError("no-git", "git not found — install git to use upload");
  const m = scrubbedMsg.toLowerCase();
  // Keep the first meaningful git line in every classified message — without it
  // a human can't take over debugging (offline especially has many root causes:
  // DNS, proxy refusal, TLS interception…).
  const detail = scrubbedMsg
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^cloning into/i.test(s))
    .slice(0, 1)
    .join("");
  // Auth is checked BEFORE network: git prefixes nearly every HTTP failure with
  // "unable to access", so a 403 ("Write access to repository not granted")
  // would otherwise misclassify as offline — exactly the debugging dead-end the
  // detail line exists to prevent.
  if (/invalid username or password|authentication failed|403|401|permission to .* denied|write access to .* not granted|could not read username/.test(m)) {
    return new GitUploadError(
      "auth-failed",
      `upload token rejected or lacks write access to the target repo — check the token's permissions, or point FORGEAX_UPLOAD_REPO at a repo you can write. git: ${detail}`,
    );
  }
  if (/could not resolve host|network is unreachable|connection (timed out|refused)|failed to connect|proxy/.test(m)) {
    return new GitUploadError(
      "offline",
      `cannot reach the upload remote — check your network / proxy (HTTPS_PROXY). git: ${detail}`,
    );
  }
  // "could not read Username" (matched above): with terminal prompts disabled it
  // is GitHub's symptom for a rejected/absent token on https (a private or
  // missing repo 404s anonymously and git falls back to asking for credentials).
  if (/non-fast-forward|rejected|failed to push|fetch first|tip of your current branch is behind/.test(m)) {
    return new GitUploadError("push-rejected", "push rejected (someone else pushed concurrently)");
  }
  return new GitUploadError("git-failed", `git failed: ${scrubbedMsg.trim().split("\n").slice(0, 2).join(" ")}`);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Clone (or init), write the archive snapshot into `<namespace>/data/<snapshotDir>/`,
 *  commit + push with backoff. Skips (no commit) when the source content hash is
 *  identical to the latest archive snapshot. */
export async function pushSubset(params: PushSubsetParams): Promise<PushSubsetResult> {
  const {
    remoteUrl,
    authHeader,
    branch,
    namespace,
    snapshotDir,
    archive,
    commitMessage,
    committer = DEFAULT_COMMITTER,
    maxAttempts = 5,
    sleep = defaultSleep,
  } = params;

  const secrets: string[] = [];
  if (authHeader) {
    secrets.push(authHeader);
    const b64 = authHeader.replace(/^basic\s+/i, "");
    secrets.push(b64);
  }

  if (archive.manifest.sourceFileCount === 0) {
    throw new GitUploadError("empty-set", "nothing to upload (the include set is empty) — refusing to push an empty snapshot");
  }

  const snapPath = `${namespace}/data/${snapshotDir}`;

  const staging = mkdtempSync(join(tmpdir(), "forgeax-upload-"));
  try {
    // Sparse partial clone: nothing but root files is materialized (the new
    // snapshot dir doesn't exist remotely yet), so the working tree stays O(1)
    // no matter how many snapshots accumulate. On local-path remotes (tests)
    // --filter is ignored with a warning; sparse-checkout still applies.
    // Transient network failures get a short bounded retry — GitHub over
    // flaky/proxied routes commonly drops one attempt.
    for (let attempt = 0; ; attempt++) {
      try {
        await git(["clone", "--no-tags", "--sparse", "--filter=blob:none", remoteUrl, staging], {
          cwd: tmpdir(),
          authHeader,
          secrets,
        });
        break;
      } catch (e) {
        const err = e as GitUploadError;
        if (err.kind !== "offline" || attempt >= 2) throw err;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        await sleep(1000 * (attempt + 1));
      }
    }
    await git(["sparse-checkout", "set", snapPath], { cwd: staging, authHeader, secrets });

    // Select / create the target branch.
    const hasBranch = await branchExistsOnRemote(staging, branch, authHeader, secrets);
    if (hasBranch) {
      await git(["checkout", "-B", branch, `origin/${branch}`], { cwd: staging, authHeader, secrets });
    } else {
      // New/empty repo: point HEAD at the (unborn) target branch. symbolic-ref is
      // robust whether or not the branch equals the clone's default unborn branch
      // (`checkout --orphan main` would fatal when already on unborn main).
      await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: staging, authHeader, secrets });
      // The clone's index still holds the default branch's entries; against an
      // unborn HEAD every one of them counts as staged, so the first commit would
      // drag the default branch's files onto the new branch (and trip the
      // escaped-path assertion below). Empty the index along with the working tree.
      await git(["read-tree", "--empty"], { cwd: staging, authHeader, secrets });
      for (const name of readdirSync(staging)) {
        if (name === ".git") continue;
        rmSync(join(staging, name), { recursive: true, force: true });
      }
    }

    // Compare before writing/staging. Old expanded snapshots have no manifest and
    // naturally cause the first archive snapshot to be created.
    const prev = await latestSnapshot(staging, namespace, authHeader, secrets);
    if (prev) {
      const raw = await git(
        ["show", `HEAD:${namespace}/data/${prev}/${MANIFEST_FILENAME}`],
        { cwd: staging, authHeader, secrets },
      ).catch(() => "");
      const previous = parseUploadArchiveManifest(raw);
      if (previous?.contentHash === archive.manifest.contentHash) {
        const head = (await git(["rev-parse", "HEAD"], { cwd: staging, authHeader, secrets })).trim();
        return {
          commit: head,
          filesChanged: 0,
          sourceFileCount: archive.manifest.sourceFileCount,
          sourceBytes: archive.manifest.sourceBytes,
          archiveBytes: previous.archiveBytes,
          skipped: true,
          path: `${namespace}/data/${prev}`,
        };
      }
    }

    // Write two files regardless of how many source files the workspace contains.
    // Existing snapshots are never touched.
    const snapAbs = join(staging, namespace, "data", snapshotDir);
    mkdirSync(snapAbs, { recursive: true });
    copyFileSync(archive.archivePath, join(snapAbs, ARCHIVE_FILENAME));
    writeFileSync(join(snapAbs, MANIFEST_FILENAME), serializeUploadArchiveManifest(archive.manifest), { mode: 0o600 });

    // Stage only the two concrete files. A directory pathspec outside the original
    // sparse cone can be treated as skip-worktree even after extending the cone;
    // concrete file pathspecs are unambiguous. -f also prevents a remote .gitignore
    // from suppressing the archive suffix.
    await git(["add", "-f", "--sparse", "--", `${snapPath}/${ARCHIVE_FILENAME}`, `${snapPath}/${MANIFEST_FILENAME}`], {
      cwd: staging,
      authHeader,
      secrets,
    });
    const staged = (await git(["diff", "--cached", "--name-only"], { cwd: staging, authHeader, secrets }))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const escaped = staged.find((p) => p !== namespace && !p.startsWith(`${namespace}/`));
    if (escaped) {
      throw new GitUploadError("git-failed", `internal: staged path escaped namespace: ${escaped}`);
    }

    await git(
      [
        "-c",
        `user.name=${committer.name}`,
        "-c",
        `user.email=${committer.email}`,
        "commit",
        "-m",
        commitMessage,
      ],
      { cwd: staging, authHeader, secrets },
    );

    await pushWithBackoff({ staging, branch, namespace, authHeader, secrets, maxAttempts, sleep });

    const commit = (await git(["rev-parse", "HEAD"], { cwd: staging, authHeader, secrets })).trim();
    return {
      commit,
      filesChanged: staged.length,
      sourceFileCount: archive.manifest.sourceFileCount,
      sourceBytes: archive.manifest.sourceBytes,
      archiveBytes: archive.manifest.archiveBytes,
      skipped: false,
      path: snapPath,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Latest timestamped snapshot dir under `<namespace>/data/` on HEAD, or null. */
async function latestSnapshot(
  staging: string,
  namespace: string,
  authHeader: string | undefined,
  secrets: string[],
): Promise<string | null> {
  const out = await git(["ls-tree", "--name-only", `HEAD:${namespace}/data`], { cwd: staging, authHeader, secrets }).catch(
    () => "",
  );
  const snaps = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => SNAPSHOT_RE.test(s))
    .sort();
  return snaps.length ? snaps[snaps.length - 1]! : null;
}


async function branchExistsOnRemote(
  staging: string,
  branch: string,
  authHeader: string | undefined,
  secrets: string[],
): Promise<boolean> {
  const out = await git(["ls-remote", "--heads", "origin", branch], { cwd: staging, authHeader, secrets }).catch(
    () => "",
  );
  return out.trim().length > 0;
}

async function pushWithBackoff(opts: {
  staging: string;
  branch: string;
  namespace: string;
  authHeader?: string;
  secrets: string[];
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { staging, branch, namespace, authHeader, secrets, maxAttempts, sleep } = opts;
  let lastErr: GitUploadError | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await git(["push", "origin", `HEAD:${branch}`], { cwd: staging, authHeader, secrets });
      return;
    } catch (e) {
      const err = e as GitUploadError;
      lastErr = err;
      // Only contention is retryable; auth/offline/no-git are terminal.
      if (err.kind !== "push-rejected") throw err;
      if (attempt === maxAttempts - 1) break;
      // Rebase onto the advanced branch — disjoint namespace subtrees never conflict.
      await git(["fetch", "origin", branch], { cwd: staging, authHeader, secrets }).catch(() => {});
      await git(["rebase", `origin/${branch}`], { cwd: staging, authHeader, secrets }).catch(async () => {
        // Should not conflict; if it somehow does, abort the rebase and let the loop fail out.
        await git(["rebase", "--abort"], { cwd: staging, authHeader, secrets }).catch(() => {});
      });
      const backoff = 200 * 2 ** attempt + Math.floor(deterministicJitter(namespace, attempt));
      await sleep(backoff);
    }
  }
  throw lastErr ?? new GitUploadError("push-rejected", "push failed after retries");
}

/** Jitter derived from namespace+attempt (no Math.random — keeps tests deterministic
 *  and spreads concurrent writers of different namespaces). */
function deterministicJitter(namespace: string, attempt: number): number {
  let h = attempt * 2654435761;
  for (let i = 0; i < namespace.length; i++) h = (h * 31 + namespace.charCodeAt(i)) >>> 0;
  return h % 200;
}
