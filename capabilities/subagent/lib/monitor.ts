import type { Scheduler } from "#src/core/scheduler.js";
import type { Event } from "#src/core/types.js";
import { eventsToMessages } from "#src/context-window/history-pipeline.js";
import { sleep } from "#src/utils.js";
import { serializeContent } from "./context.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";

const POLL_INTERVAL_MS = 300;

export type SubagentOutcome =
  | { status: "completed"; result: string }
  | { status: "question"; question: string }
  | { status: "error"; error: string };

/**
 * Outcome subset that `pollSubagentOnce` can produce. `question` is detected
 * via a separate EventBus observer in foreground (waitForSubagentCompletion);
 * the poll path itself never returns it.
 */
type PollOutcome = Exclude<SubagentOutcome, { status: "question" }>;

// ─── Foreground: block until subagent completes or asks a question ──────────

export async function waitForSubagentCompletion(opts: {
  scheduler: Scheduler;
  subagentId: string;
  signal?: AbortSignal;
}): Promise<SubagentOutcome> {
  const { scheduler, subagentId, signal } = opts;

  let questionResult: SubagentOutcome | null = null;
  const unsub = scheduler.eventBus.observe((ev: Event, emitterId?: string) => {
    if (
      ev.type === "report" &&
      emitterId === subagentId &&
      (ev.payload as Record<string, unknown>).reportType === "question"
    ) {
      questionResult = {
        status: "question",
        question: String((ev.payload as Record<string, unknown>).content ?? ""),
      };
    }
  });

  try {
    for (;;) {
      if (questionResult) return questionResult;
      if (signal?.aborted) {
        await Promise.resolve(scheduler.controlAgent("shutdown", subagentId)).catch(() => {});
        return { status: "error", error: "Subagent interrupted by parent turn." };
      }
      const outcome = await pollSubagentOnce(scheduler, subagentId);
      if (outcome) return outcome;
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    unsub();
  }
}

// ─── Background: fire-and-forget monitor ────────────────────────────────────

export function monitorBackgroundSubagent(opts: {
  scheduler: Scheduler;
  subagentId: string;
  parentId: string;
  type: string;
  /** Emit via the parent-bound EventBus facade, while overriding emitterId to subagentId. */
  emitParentEvent: (event: Event, emitterId?: string) => void;
  onComplete: (outcome: SubagentOutcome) => void;
}): void {
  const { scheduler, subagentId, parentId, type, emitParentEvent, onComplete } = opts;
  void (async () => {
    for (;;) {
      const outcome = await pollSubagentOnce(scheduler, subagentId);
      if (outcome) {
        if (outcome.status === "completed") {
          emitParentEvent({
            source: "tool:subagent",
            type: "subagent_result",
            payload: { content: outcome.result, subagentId, type },
            ts: Date.now(), to: parentId, priority: 0, handoff: "innerLoop",
          }, subagentId);
        } else {
          emitParentEvent({
            source: "tool:subagent",
            type: "subagent_error",
            payload: { error: outcome.error, subagentId, type },
            ts: Date.now(), to: parentId, priority: 0, handoff: "innerLoop",
          }, subagentId);
        }
        onComplete(outcome);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();
}

// ─── Shared polling core ────────────────────────────────────────────────────
//
// Completion is judged by two orthogonal signals:
//
//   1. RUNNING (TeamBoard, in-memory) — authoritative liveness.
//      RUNNING=false means the agent is NOT inside a turn right now.
//      Set to false in conscious-agent.ts's turn `finally` block, regardless
//      of whether the turn ended cleanly, errored, or was aborted.
//
//   2. assistant message (WAL) — shape of exit.
//      Present → clean exit with output.
//      Absent  → silent exit (e.g. retryable LLM error path that breaks
//                 out of the turn loop without emitting a partial response).
//
// We additionally guard against the boot window (RUNNING=false because the
// subagent hasn't picked up its task event yet) by requiring at least one
// `hook:turnEnd` to have been emitted — that proves a turn actually executed.
//
// This makes the monitor robust to subagents that "give up silently": before
// this fix, retryable LLM errors after exhausted retries would leave the
// subagent with RUNNING=false and zero assistant messages forever, and the
// monitor would poll endlessly without ever calling onComplete → finalize.
async function pollSubagentOnce(
  scheduler: Scheduler,
  subagentId: string,
): Promise<PollOutcome | null> {
  const agent = scheduler.getAgent(subagentId);
  if (!agent) {
    // Subagent vanished from the scheduler before we observed a normal completion.
    // The happy path is: turn ends → assistant message in WAL → poll returns
    // completed → onComplete → finalizeSubagent removes the agent. By the time
    // monitor sees `!agent`, finalize has already returned (no further polling)
    // OR the agent died unexpectedly (process crash / external disposal /
    // stop-without-finalize). In either case the right answer is NOT "completed
    // with empty result" — that masks crashes as success. Treat as error so the
    // parent gets a truthful signal.
    return {
      status: "error",
      error: `Subagent ${subagentId} vanished from the scheduler unexpectedly ` +
        `(process crash, external disposal, or stop without finalize). ` +
        `No final assistant message was captured. Check the subagent's debug.log.`,
    };
  }

  const running = scheduler.getTeamBoard().get(subagentId, TEAMBOARD_KEYS.RUNNING);
  if (running === true) return null;

  // Active-children guard: a subagent that still has live children must NOT be
  // finalized — its children's `subagent_result` events are routed back to this
  // subagent (see emit `to: parentId` above), and finalize would tear the parent
  // down before those events can wake it for processing. Recursively this is the
  // root-cause fix for the "background fan-out from a subagent leaks orphans" bug:
  // when a subagent fans out N background children and ends its turn, this guard
  // keeps it alive; each child's completion wakes it, it processes, ends another
  // turn, re-checks; only when every child has finalized (childIds empty) does
  // the next poll proceed to the completed/error branch below.
  const tree = scheduler.getAgentTree();
  const node = tree?.getNode(subagentId);
  if (node && node.childIds.length > 0) return null;

  const events = await agent.ledger.readEventsFromTail(() => true);
  const turnEnded = events.some(e => e.type === "hook:turnEnd");
  if (!turnEnded) return null;

  const messages = eventsToMessages(events);
  const last = messages[messages.length - 1];
  const text = last?.role === "assistant" && !last.toolCalls?.length
    ? serializeContent(last.content) : null;

  if (text) return { status: "completed", result: text };

  return {
    status: "error",
    error: `Subagent ${subagentId} exited without producing a final assistant message ` +
      `(likely LLM error after retries exhausted, or aborted mid-turn). ` +
      `Check the subagent's debug.log and ledger.xml for details.`,
  };
}
