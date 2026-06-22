// @desc Shared types and helpers for MR lifecycle tracking
import type { AgentContext } from "#src/core/types.js";
import { getRemoteUrl, extractProjectPath, extractHost } from "#src/git-common/git-utils.js";
import { readToolKeys, getKey, missingKeyMessage } from "#src/fs/tool-keys.js";
import { deriveApiBase } from "./evolve-pr.js";

export const ACTIVE_MRS_KEY = "active_mrs";

export type MRStatus = "open" | "closed";

export interface TrackedMR {
  iid: number;
  branch: string;
  projectPath: string;
  apiBase: string;
  url: string;
  createdAt: number;
  status: MRStatus;
  /** Why this MR was closed — set by tracker or manual close */
  closedReason?: "merged" | "closed" | "lost" | "manual";
}

// Legacy compat: entries without status field are treated as open
function normalize(raw: Record<string, unknown>): TrackedMR {
  return {
    ...raw,
    status: (raw.status as MRStatus) ?? "open",
  } as TrackedMR;
}

export interface GitConfig {
  token: string;
  apiBase: string;
}

/** Read tracked MR list from TeamBoard. Default: open only. */
export function getTrackedMRs(ctx: AgentContext, opts?: { includeClosed?: boolean }): TrackedMR[] {
  const raw = ctx.teamBoard.get(ctx.agentId, ACTIVE_MRS_KEY);
  const all = Array.isArray(raw) ? (raw as Record<string, unknown>[]).map(normalize) : [];
  if (opts?.includeClosed) return all;
  return all.filter((m) => m.status === "open");
}

/** Add or update an MR entry (always sets status to open) */
export function upsertTrackedMR(ctx: AgentContext, mr: Omit<TrackedMR, "status" | "closedReason">): void {
  const all = getTrackedMRs(ctx, { includeClosed: true });
  const idx = all.findIndex((m) => m.iid === mr.iid && m.projectPath === mr.projectPath);
  const entry: TrackedMR = { ...mr, status: "open" };
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  ctx.teamBoard.set(ctx.agentId, ACTIVE_MRS_KEY, all, { persist: true });
}

/** Mark an MR as closed (soft delete — preserved in history) */
export function closeTrackedMR(
  ctx: AgentContext, iid: number, projectPath: string,
  reason: TrackedMR["closedReason"] = "manual",
): void {
  const all = getTrackedMRs(ctx, { includeClosed: true });
  const target = all.find((m) => m.iid === iid && m.projectPath === projectPath);
  if (!target) return;
  target.status = "closed";
  target.closedReason = reason;
  ctx.teamBoard.set(ctx.agentId, ACTIVE_MRS_KEY, all, { persist: true });
}

/** Hard remove — only for truly cleaning up invalid entries */
export function removeTrackedMR(ctx: AgentContext, iid: number, projectPath: string): void {
  const all = getTrackedMRs(ctx, { includeClosed: true }).filter(
    (m) => !(m.iid === iid && m.projectPath === projectPath),
  );
  if (all.length > 0) {
    ctx.teamBoard.set(ctx.agentId, ACTIVE_MRS_KEY, all, { persist: true });
  } else {
    ctx.teamBoard.remove(ctx.agentId, ACTIVE_MRS_KEY);
  }
}

/** Read git API config from key/tools.json */
export async function readGitConfig(ctx: AgentContext, remoteUrl: string): Promise<GitConfig> {
  const result = await readToolKeys(ctx.pathManager);
  const defaultBase = deriveApiBase(remoteUrl);
  return {
    token: getKey(result, "git_api_token") ?? "",
    apiBase: result.keys["git_api_base"] || defaultBase,
  };
}

/** Generate a user-facing message when git_api_token is missing */
export function gitTokenMissingMessage(fileExists: boolean): string {
  return missingKeyMessage("git_api_token", "无法访问 GitLab API（提交 MR / 查询 MR 状态 / 自动追踪）", fileExists);
}

/** Read tool keys result for checking file existence */
export { readToolKeys } from "#src/fs/tool-keys.js";

/** Derive MR web URL from remote URL and iid */
export function deriveMrWebUrl(remoteUrl: string, iid: number): string {
  const host = extractHost(remoteUrl);
  const path = extractProjectPath(remoteUrl);
  return host && iid ? `https://${host}/${path}/-/merge_requests/${iid}` : "";
}

/** Get project path and API base from instance root */
export function getProjectInfo(instanceRoot: string): { remoteUrl: string; projectPath: string } {
  const remoteUrl = getRemoteUrl(instanceRoot);
  const projectPath = extractProjectPath(remoteUrl);
  return { remoteUrl, projectPath };
}

// ─── v3-compatible API helpers ───────────────────────────────────────────────

/** Raw MR data from GitLab v3 list endpoint */
export interface MRListItem {
  id: number;            // global database ID (used for notes endpoint)
  iid: number;           // project-local IID
  state: string;         // opened | merged | closed
  mergeStatus: string;   // can_be_merged | cannot_be_merged | unchecked
  sourceCommit: string;  // source branch HEAD SHA (v3 field: source_commit)
  mergeCommitSha?: string;
  title: string;
  webUrl: string;
  raw: Record<string, unknown>;  // full API response for caller inspection
}

/**
 * Fetch a single MR via the list endpoint + iid matching.
 * No state filter — v3 API returns all states by default (v3 does not support state=all).
 */
export async function fetchMRViaList(
  apiBase: string, projectPath: string, branch: string, iid: number, token: string,
): Promise<MRListItem | null> {
  const enc = encodeURIComponent(projectPath);
  const url = `${apiBase}/projects/${enc}/merge_requests?source_branch=${encodeURIComponent(branch)}&per_page=5`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) return null;
  const list = (await res.json()) as Record<string, unknown>[];
  const match = list.find((m) => (m.iid as number) === iid);
  if (!match) return null;
  return {
    id: match.id as number,
    iid: match.iid as number,
    state: String(match.state ?? "unknown"),
    mergeStatus: String(match.merge_status ?? "unknown"),
    sourceCommit: String(match.source_commit ?? ""),
    mergeCommitSha: match.merge_commit_sha ? String(match.merge_commit_sha) : undefined,
    title: String(match.title ?? ""),
    webUrl: String(match.web_url ?? ""),
    raw: match,
  };
}

/** Build notes endpoint URL using global MR id (v3 compatible) */
export function notesUrl(apiBase: string, projectPath: string, globalId: number): string {
  return `${apiBase}/projects/${encodeURIComponent(projectPath)}/merge_requests/${globalId}/notes`;
}
