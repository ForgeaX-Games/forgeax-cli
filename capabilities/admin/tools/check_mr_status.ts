// @desc Check MR status from GitLab API — stateless, reads tracked MRs for scope
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  getTrackedMRs, readGitConfig, readToolKeys, gitTokenMissingMessage, fetchMRViaList, notesUrl,
  type TrackedMR,
} from "../lib/active-mrs.js";
import { getRemoteUrl } from "#src/git-common/git-utils.js";

interface MRDetail {
  iid: number;
  globalId: number;
  title: string;
  state: string;
  mergeStatus: string;
  sourceCommit: string;
  webUrl: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  reviewNotes: string[];
  /** Local tracking status */
  trackingStatus: string;
  closedReason?: string;
}

async function fetchMRDetail(mr: TrackedMR, token: string): Promise<MRDetail | string> {
  const data = await fetchMRViaList(mr.apiBase, mr.projectPath, mr.branch, mr.iid, token);
  if (!data) return `MR !${mr.iid} (branch: ${mr.branch}): not found via API`;

  const detail: MRDetail = {
    iid: data.iid,
    globalId: data.id,
    title: data.title,
    state: data.state,
    mergeStatus: data.mergeStatus,
    sourceCommit: data.sourceCommit,
    webUrl: data.webUrl || mr.url,
    reviewNotes: [],
    trackingStatus: mr.status,
    closedReason: mr.closedReason,
  };

  if (data.raw.merged_at) detail.mergedAt = String(data.raw.merged_at);
  if (data.mergeCommitSha) detail.mergeCommitSha = data.mergeCommitSha;

  // Fetch recent discussion notes using global id
  try {
    const url = `${notesUrl(mr.apiBase, mr.projectPath, data.id)}?sort=desc&per_page=5`;
    const notesRes = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    if (notesRes.ok) {
      const notes = (await notesRes.json()) as Record<string, unknown>[];
      for (const n of notes) {
        if (n.system) continue;
        const author = (n.author as Record<string, unknown>)?.name ?? "unknown";
        const body = String(n.body ?? "").slice(0, 200);
        detail.reviewNotes.push(`${author}: ${body}`);
      }
    }
  } catch {}

  return detail;
}

function formatDetail(d: MRDetail): string {
  const lines: string[] = [];
  const stateIcon = d.state === "merged" ? "✅" : d.state === "opened" ? "🔵" : d.state === "closed" ? "⚫" : "❓";
  lines.push(`${stateIcon} MR !${d.iid}: ${d.title}`);
  lines.push(`   State: ${d.state}  |  Merge: ${d.mergeStatus}  |  ${d.webUrl}`);
  lines.push(`   Source commit: ${d.sourceCommit.slice(0, 12)}`);

  if (d.trackingStatus === "closed") {
    lines.push(`   Tracking: closed (${d.closedReason ?? "unknown"})`);
  }

  if (d.mergedAt) lines.push(`   Merged: ${d.mergedAt} (commit: ${d.mergeCommitSha ?? "?"})`);
  if (d.mergeStatus === "cannot_be_merged") lines.push(`   ⚠️  Has merge conflicts — may need rebase`);
  if (d.reviewNotes.length > 0) {
    lines.push(`   Recent comments (${d.reviewNotes.length}):`);
    for (const note of d.reviewNotes) {
      lines.push(`     - ${note}`);
    }
  }
  return lines.join("\n");
}

export default {
  name: "check_mr_status",
  description:
    "Check the current status of tracked merge requests. " +
    "Queries GitLab API for each MR in the tracking list. " +
    "Returns MR state (open/merged/closed), merge status, and recent review comments. " +
    "By default shows only open MRs. Set include_closed=true to see all.",
  input_schema: {
    type: "object",
    properties: {
      iid: {
        type: "number",
        description: "Specific MR iid to check. Omit to list all tracked MRs.",
      },
      include_closed: {
        type: "boolean",
        description: "Include closed/merged MRs in the list. Default: false.",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const includeClosed = (args.include_closed as boolean) ?? false;
    const allMRs = getTrackedMRs(ctx, { includeClosed });

    if (allMRs.length === 0) {
      return includeClosed
        ? "No MRs are being tracked (including closed). Submit an MR with `submit_mr` to start tracking."
        : "No open MRs are being tracked. Use include_closed=true to see closed MRs, or submit_mr to create one.";
    }

    const remoteUrl = getRemoteUrl(ctx.pathManager.root());
    const gitConfig = await readGitConfig(ctx, remoteUrl);
    if (!gitConfig.token) {
      const keysResult = await readToolKeys(ctx.pathManager);
      return gitTokenMissingMessage(keysResult.fileExists);
    }

    const targetIid = args.iid as number | undefined;
    const toCheck = targetIid
      ? allMRs.filter((m) => m.iid === targetIid)
      : allMRs;

    if (toCheck.length === 0) {
      return `MR !${targetIid} is not in the tracking list. Tracked: ${allMRs.map((m) => `!${m.iid}`).join(", ")}`;
    }

    const results: string[] = [];
    for (const mr of toCheck) {
      const detail = await fetchMRDetail(mr, gitConfig.token);
      results.push(typeof detail === "string" ? detail : formatDetail(detail));
    }

    return results.join("\n\n");
  },
  serial: false,
} satisfies ToolDefinition;
