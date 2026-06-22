// @desc Git plumbing for creating PR branches and remote HEAD polling
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { getTerminalManager } from "#src/terminal/manager.js";
import { getRemoteUrl, extractHost } from "#src/git-common/git-utils.js";

function git(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string; timeout?: number }): string {
  return getTerminalManager().execSync("git", args, {
    cwd: opts?.cwd,
    env: opts?.env,
    input: opts?.input,
    timeout: opts?.timeout,
  });
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface PrRequest {
  requestedBy: string;
  ts: number;
  title: string;
  description: string;
  branch: string;
  /** When set, only include these paths in the PR commit (relative to repo root). */
  files?: string[];
}

export interface PrResult {
  branch: string;
  commitHash: string;
  url: string;
  error?: string;
  filesChanged?: string[];
  /** True when pushing to a branch that already existed (update vs create). */
  isUpdate?: boolean;
}

// ─── GitLab helpers ──────────────────────────────────────────────────────────

/** Derive GitLab API v3 base URL from a remote URL. */
export function deriveApiBase(remoteUrl: string): string {
  const host = extractHost(remoteUrl);
  return host ? `https://${host}/api/v3` : "";
}

/** Derive web MR-creation URL from a remote URL + branch info. */
export function deriveMrUrl(remoteUrl: string, sourceBranch: string, targetBranch: string): string {
  let webBase = remoteUrl.replace(/\.git$/, "");
  const ssh = webBase.match(/^git@([^:]+):(.+)$/);
  if (ssh) webBase = `https://${ssh[1]}/${ssh[2]}`;
  return `${webBase}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(sourceBranch)}&merge_request[target_branch]=${encodeURIComponent(targetBranch)}`;
}

// ─── PR branch creation (git plumbing) ───────────────────────────────────────

interface StatusEntry {
  flag: string;
  path: string;
  origPath?: string;
}

function parseGitStatus(raw: string): StatusEntry[] {
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const m = line.match(/^(.{1,2})\s(.+)$/);
    if (!m) return { flag: "??", path: line.trim(), origPath: undefined };
    const flag = m[1].length === 1 ? ` ${m[1]}` : m[1];
    let path = m[2];
    let origPath: string | undefined;
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) {
      origPath = path.slice(0, arrow);
      path = path.slice(arrow + 4);
    }
    return { flag, path, origPath };
  });
}

/**
 * Create a PR branch from uncommitted changes using git plumbing.
 *
 * Temp index → write-tree → commit-tree → update-ref → push.
 * The working tree is NEVER modified.
 */
export function createEvolvePR(repoDir: string, request: PrRequest, baseBranch: string): PrResult {
  const { title, description, branch } = request;

  try {
    const statusRaw = git(["status", "--porcelain", "-uall"], { cwd: repoDir });
    let entries = parseGitStatus(statusRaw);

    const parentHash = git(["rev-parse", "HEAD"], { cwd: repoDir });
    let branchExists = false;
    let branchRef = "";
    try {
      git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoDir });
      branchExists = true;
      branchRef = `refs/heads/${branch}`;
    } catch {}
    if (!branchExists) {
      try {
        git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], { cwd: repoDir });
        branchExists = true;
        branchRef = `refs/remotes/origin/${branch}`;
      } catch {}
    }

    if (request.files?.length) {
      // Split user input into exact file paths vs directory prefixes.
      // A trailing "/" marks a directory (e.g. "src/llm/" matches all files under src/llm).
      const exactFiles = new Set<string>();
      const dirPrefixes: string[] = [];
      for (const raw of request.files) {
        const f = raw.replace(/^\.[\/]/, "");
        if (f.endsWith("/")) dirPrefixes.push(f);
        else exactFiles.add(f);
      }
      // Continue-push semantics: when re-pushing to an existing branch,
      // preserve files that branch already carries (so working-tree state of
      // those files is re-committed into the new tip).
      if (branchExists) {
        try {
          const diffRaw = git(["diff-tree", "--no-commit-id", "--name-only", "-r", `${parentHash}..${branchRef}`], { cwd: repoDir });
          for (const f of diffRaw.split("\n").filter(Boolean)) {
            exactFiles.add(f);
          }
        } catch {}
      }
      const matches = (p: string): boolean => {
        if (exactFiles.has(p)) return true;
        for (const prefix of dirPrefixes) {
          if (p.startsWith(prefix)) return true;
        }
        return false;
      };
      entries = entries.filter(e => matches(e.path) || (e.origPath && matches(e.origPath)));
    }
    if (entries.length === 0) {
      return { branch, commitHash: "", url: "", error: "No uncommitted changes detected" };
    }

    const tmpIndex = join(repoDir, `.git/tmp-pr-index-${Date.now()}`);
    const authorName = git(["config", "user.name"], { cwd: repoDir });
    const authorEmail = git(["config", "user.email"], { cwd: repoDir });
    const prEnv: Record<string, string> = {
      GIT_INDEX_FILE: tmpIndex,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    try {
      git(["read-tree", parentHash], { cwd: repoDir, env: prEnv });

      for (const entry of entries) {
        if (entry.flag.includes("D")) {
          git(["update-index", "--force-remove", "--", entry.path], { cwd: repoDir, env: prEnv });
        } else {
          git(["add", "--", entry.path], { cwd: repoDir, env: prEnv });
        }
        if (entry.origPath && entry.flag.includes("R")) {
          git(["update-index", "--force-remove", "--", entry.origPath], { cwd: repoDir, env: prEnv });
        }
      }

      const tree = git(["write-tree"], { cwd: repoDir, env: prEnv });
      const commitMsg = description ? `${title}\n\n${description}` : title;
      const commitHash = git(
        ["commit-tree", tree, "-p", parentHash],
        { cwd: repoDir, env: prEnv, input: commitMsg },
      );

      git(["update-ref", `refs/heads/${branch}`, commitHash], { cwd: repoDir });
    } finally {
      try { getSandboxFs().unlinkSync(tmpIndex); } catch {}
    }

    const shortHash = git(["rev-parse", "--short", branch], { cwd: repoDir });

    git(["push", "--force", "origin", branch], { cwd: repoDir, timeout: 60_000 });

    try { git(["branch", "-D", branch], { cwd: repoDir }); } catch {}

    let mrUrl = "";
    try {
      const remoteUrl = getRemoteUrl(repoDir);
      mrUrl = deriveMrUrl(remoteUrl, branch, baseBranch);
    } catch {}

    const filesChanged = entries.map(e => `${e.flag.trim()} ${e.path}`);

    return { branch, commitHash: shortHash, url: mrUrl, filesChanged, isUpdate: branchExists };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { branch, commitHash: "", url: "", error: msg };
  }
}

// ─── Remote HEAD polling ─────────────────────────────────────────────────────

/**
 * Check if remote HEAD of `branch` has advanced past `lastKnownHash`.
 * Caller should `fetchRemote()` first to ensure refs are fresh.
 */
export function checkRemoteHead(
  repoDir: string,
  branch: string,
  lastKnownHash: string | null,
): { newHead: string; commits: string } | null {
  try {
    const remoteHead = git(["rev-parse", `origin/${branch}`], { cwd: repoDir });

    if (lastKnownHash === null || remoteHead === lastKnownHash) return null;

    const commits = git(
      ["log", "--oneline", `${lastKnownHash}..${remoteHead}`],
      { cwd: repoDir },
    );
    return { newHead: remoteHead, commits };
  } catch {
    return null;
  }
}
