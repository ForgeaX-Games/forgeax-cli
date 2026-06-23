// @desc Generic git utility functions — branch detection, remote URL parsing
import { getTerminalManager } from "../terminal/manager.js";

function git(args: string[], opts?: { cwd?: string; timeout?: number }): string {
  return getTerminalManager().execSync("git", args, opts);
}

/** Fetch latest remote state without modifying the working tree. */
export function fetchRemote(cwd: string): void {
  git(["fetch", "origin", "--quiet"], { cwd, timeout: 30_000 });
}

/**
 * Detect the remote default branch (e.g. origin/HEAD → agentteam-os-future).
 * Falls back to `git remote set-head --auto` if origin/HEAD is not set,
 * then to local HEAD as last resort.
 */
export function detectRemoteDefaultBranch(cwd: string): string {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
    return ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    try {
      git(["remote", "set-head", "origin", "--auto"], { cwd, timeout: 15_000 });
      const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
      return ref.replace(/^refs\/remotes\/origin\//, "");
    } catch {
      return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    }
  }
}

/** Current checked-out branch name (local HEAD). */
export function detectCurrentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

/** Origin remote URL of a repo / worktree. */
export function getRemoteUrl(cwd: string): string {
  return git(["remote", "get-url", "origin"], { cwd });
}

/** Extract host from a git remote URL (ssh or https). */
export function extractHost(remoteUrl: string): string {
  const ssh = remoteUrl.match(/^git@([^:]+):/);
  if (ssh) return ssh[1];
  const http = remoteUrl.match(/^https?:\/\/([^/]+)/);
  if (http) return http[1];
  return "";
}

/** Extract namespace/project path from a git remote URL. */
export function extractProjectPath(remoteUrl: string): string {
  let u = remoteUrl.replace(/\.git$/, "");
  const ssh = u.match(/^git@[^:]+:(.+)$/);
  if (ssh) return ssh[1];
  const http = u.match(/https?:\/\/[^/]+\/(.+)$/);
  if (http) return http[1];
  return u;
}
