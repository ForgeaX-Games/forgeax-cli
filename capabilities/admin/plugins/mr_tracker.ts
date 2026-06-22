// @desc Poll GitLab API for MR status changes; emit events on merge/close/review/conflict/update
import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext, SelfEvent } from "#src/core/types.js";
import {
  getTrackedMRs, closeTrackedMR, readGitConfig, fetchMRViaList, notesUrl,
  type TrackedMR,
} from "../lib/active-mrs.js";
import { getRemoteUrl } from "#src/git-common/git-utils.js";

const POLL_INTERVAL_MS = 60_000;
/** After this many consecutive poll failures, mark MR as closed (lost) */
const MAX_POLL_FAILURES = 5;

interface MRSnapshot {
  state: string;
  mergeCommitSha?: string;
  mergeStatus: string;
  sourceCommit: string;
  lastNoteId: number;
}

export default function create(ctx: AgentContext): PluginSource {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const known = new Map<number, MRSnapshot>();
  const pollFailures = new Map<number, number>();

  function emit(event: SelfEvent): void {
    ctx.eventBus.emitToSelf(event);
  }

  async function pollMRs(): Promise<void> {
    if (stopped) return;

    // Only poll open MRs
    const openMRs = getTrackedMRs(ctx);
    if (openMRs.length === 0) return;

    const remoteUrl = getRemoteUrl(ctx.pathManager.root());
    const gitConfig = await readGitConfig(ctx, remoteUrl);
    if (!gitConfig.token) return;

    for (const mr of openMRs) {
      if (stopped) return;
      try {
        await checkSingleMR(mr, gitConfig.token);
      } catch {
        // Silently skip failed MR checks — will retry next poll
      }
    }

    // Clean up known entries for MRs no longer open
    const openIids = new Set(openMRs.map((m) => m.iid));
    for (const iid of known.keys()) {
      if (!openIids.has(iid)) known.delete(iid);
    }
  }

  async function checkSingleMR(mr: TrackedMR, token: string): Promise<void> {
    const data = await fetchMRViaList(mr.apiBase, mr.projectPath, mr.branch, mr.iid, token);

    // ── Poll failure: API returned null (MR not found) ──
    if (!data) {
      const failures = (pollFailures.get(mr.iid) ?? 0) + 1;
      pollFailures.set(mr.iid, failures);

      if (failures >= MAX_POLL_FAILURES) {
        emit({
          source: "mr_tracker",
          type: "mr_lost",
          payload: {
            content: `[MR Tracker] MR !${mr.iid} not found after ${failures} consecutive polls — marked as closed.\n${mr.url}`,
            iid: mr.iid,
            url: mr.url,
          },
          ts: Date.now(),
          handoff: "silent",
        });
        closeTrackedMR(ctx, mr.iid, mr.projectPath, "lost");
        known.delete(mr.iid);
        pollFailures.delete(mr.iid);
      }
      return;
    }

    // Reset failure counter on successful poll
    pollFailures.delete(mr.iid);

    const prev = known.get(mr.iid);

    // ── First poll: establish baseline, no events ──
    if (!prev) {
      const lastNoteId = await getLatestNoteId(mr.apiBase, mr.projectPath, data.id, token);
      known.set(mr.iid, {
        state: data.state,
        mergeCommitSha: data.mergeCommitSha,
        mergeStatus: data.mergeStatus,
        sourceCommit: data.sourceCommit,
        lastNoteId,
      });
      return;
    }

    // ── State changed: merged ──
    if (data.state === "merged" && prev.state !== "merged") {
      emit({
        source: "mr_tracker",
        type: "mr_merged",
        payload: {
          content: `[MR Tracker] MR !${mr.iid} has been merged.${data.mergeCommitSha ? ` Merge commit: ${data.mergeCommitSha}` : ""}\n${mr.url}`,
          iid: mr.iid,
          mergeCommitSha: data.mergeCommitSha,
          url: mr.url,
        },
        ts: Date.now(),
        handoff: "silent",
      });
      closeTrackedMR(ctx, mr.iid, mr.projectPath, "merged");
      known.delete(mr.iid);
      return;
    }

    // ── State changed: closed ──
    if (data.state === "closed" && prev.state !== "closed") {
      emit({
        source: "mr_tracker",
        type: "mr_closed",
        payload: {
          content: `[MR Tracker] MR !${mr.iid} has been closed.\n${mr.url}`,
          iid: mr.iid,
          url: mr.url,
        },
        ts: Date.now(),
        handoff: "turn",
      });
      closeTrackedMR(ctx, mr.iid, mr.projectPath, "closed");
      known.delete(mr.iid);
      return;
    }

    // ── merge_status changed: conflict detection ──
    if (data.mergeStatus !== "unchecked" && data.mergeStatus !== prev.mergeStatus) {
      if (data.mergeStatus === "cannot_be_merged" && prev.mergeStatus !== "cannot_be_merged") {
        emit({
          source: "mr_tracker",
          type: "mr_conflict_detected",
          payload: {
            content: `[MR Tracker] MR !${mr.iid} has merge conflicts (merge_status: cannot_be_merged). May need rebase.\n${mr.url}`,
            iid: mr.iid,
            url: mr.url,
          },
          ts: Date.now(),
          handoff: "turn",
        });
      } else if (data.mergeStatus === "can_be_merged" && prev.mergeStatus === "cannot_be_merged") {
        emit({
          source: "mr_tracker",
          type: "mr_conflict_resolved",
          payload: {
            content: `[MR Tracker] MR !${mr.iid} conflicts resolved — now mergeable.\n${mr.url}`,
            iid: mr.iid,
            url: mr.url,
          },
          ts: Date.now(),
          handoff: "turn",
        });
      }
    }

    // ── Check for new review notes ──
    const latestNoteId = await getLatestNoteId(mr.apiBase, mr.projectPath, data.id, token);
    if (latestNoteId > prev.lastNoteId) {
      const newNotes = await getNewNotes(mr.apiBase, mr.projectPath, data.id, token, prev.lastNoteId);
      if (newNotes.length > 0) {
        const summary = newNotes.map((n) => `  ${n.author}: ${n.body}`).join("\n");
        emit({
          source: "mr_tracker",
          type: "mr_reviewed",
          payload: {
            content: `[MR Tracker] MR !${mr.iid} has ${newNotes.length} new comment(s):\n${summary}\n${mr.url}`,
            iid: mr.iid,
            url: mr.url,
            noteCount: newNotes.length,
          },
          ts: Date.now(),
          handoff: "turn",
        });
      }
    }

    // ── Update snapshot ──
    known.set(mr.iid, {
      state: data.state,
      mergeCommitSha: data.mergeCommitSha,
      mergeStatus: data.mergeStatus,
      sourceCommit: data.sourceCommit,
      lastNoteId: Math.max(latestNoteId, prev.lastNoteId),
    });
  }

  // ── Notes helpers (use global MR id for v3 compatibility) ──

  async function getLatestNoteId(
    apiBase: string, projectPath: string, globalId: number, token: string,
  ): Promise<number> {
    try {
      const url = `${notesUrl(apiBase, projectPath, globalId)}?sort=desc&per_page=1`;
      const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
      if (!res.ok) return 0;
      const notes = (await res.json()) as Record<string, unknown>[];
      if (notes.length === 0) return 0;
      return (notes[0].id as number) ?? 0;
    } catch {
      return 0;
    }
  }

  async function getNewNotes(
    apiBase: string, projectPath: string, globalId: number, token: string, afterId: number,
  ): Promise<Array<{ author: string; body: string }>> {
    try {
      const url = `${notesUrl(apiBase, projectPath, globalId)}?sort=asc&per_page=10`;
      const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
      if (!res.ok) return [];
      const notes = (await res.json()) as Record<string, unknown>[];
      return notes
        .filter((n) => !n.system && (n.id as number) > afterId)
        .map((n) => ({
          author: String((n.author as Record<string, unknown>)?.name ?? "unknown"),
          body: String(n.body ?? ""),
        }));
    } catch {
      return [];
    }
  }

  return {
    name: "mr_tracker",

    start() {
      stopped = false;
      timer = setInterval(() => { pollMRs().catch(() => {}); }, POLL_INTERVAL_MS);
      // Poll once after 5s on startup
      setTimeout(() => { if (!stopped) pollMRs().catch(() => {}); }, 5_000);
    },

    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      known.clear();
      pollFailures.clear();
    },
  };
}
