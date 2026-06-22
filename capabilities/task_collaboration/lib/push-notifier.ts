// @desc Centralized push rules for the task orchestrator (publish / state-change / content-change → user_message + hook).

import type { AgentContext } from "#src/core/types.js";
import { resolveNotify } from "./task-scope.js";
import { readTaskFile, readTaskState, taskExists } from "./task-dir.js";
import { readTaskLog } from "./task-log.js";
import type { Stage, TaskBoardStatus, TaskFile, TaskState } from "./task-types.js";

const TASK_REF_PREFIX = "@task:";

// ─── low-level push primitives ────────────────────────────────────────────────

/** Push a user_message to one agent's queue with innerLoop priority. */
export function pushTaskMessage(ctx: AgentContext, recipient: string, content: string): void {
  ctx.eventBus.emit({
    source: ctx.agentId,
    type: "message",
    to: recipient,
    payload: { content },
    ts: Date.now(),
    handoff: "innerLoop",
    priority: 0,
  }, ctx.agentId);
}

function emitTaskNotifyHook(
  ctx: AgentContext,
  reason: string,
  task: TaskFile,
  extras: Record<string, unknown> = {},
): void {
  ctx.eventBus.hook("task_notify", {
    content: `task ${task.id} ${reason}`,
    reason,
    task_id: task.id,
    task,
    notify: task.notify,
    ...extras,
  });
}

// ─── refs auto-expansion ──────────────────────────────────────────────────────

interface ExpandedRef {
  raw: string;
  /** Set when raw is `@task:<id>` and that task is currently closed. */
  closedTaskSummary?: string;
}

function expandRefs(refs: string[] | undefined, ctx: AgentContext): ExpandedRef[] {
  const out: ExpandedRef[] = [];
  for (const r of refs ?? []) {
    if (r.startsWith(TASK_REF_PREFIX)) {
      const tid = r.slice(TASK_REF_PREFIX.length);
      if (taskExists(ctx.pathManager, tid)) {
        try {
          const t = readTaskFile(ctx.pathManager, tid);
          const s = readTaskState(ctx.pathManager, tid);
          if (s.status === "completed" || s.status === "closed" || s.status === "failed") {
            const reason = lastClosingReason(ctx, tid);
            const summary = `${t.title} → ${s.status}${reason ? `: ${reason}` : ""}`;
            out.push({ raw: r, closedTaskSummary: summary });
            continue;
          }
        } catch { /* ignore parse errors */ }
      }
    }
    out.push({ raw: r });
  }
  return out;
}

function lastClosingReason(ctx: AgentContext, taskId: string): string | undefined {
  try {
    const log = readTaskLog(ctx.pathManager, taskId);
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.type === "state_change" && (e.to === "completed" || e.to === "closed" || e.to === "failed")) {
        return e.reason;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

// ─── message body formatting ──────────────────────────────────────────────────

function formatPublishMessage(task: TaskFile, expanded: ExpandedRef[]): string {
  const lines: string[] = [];
  lines.push(`📌 New task: ${task.title} (id=${task.id})`);
  if (task.description) lines.push("", task.description);
  if (expanded.length > 0) {
    lines.push("", "refs:");
    for (const r of expanded) {
      if (r.closedTaskSummary) {
        lines.push(`  - ${r.raw}  (previously: ${r.closedTaskSummary})`);
      } else {
        lines.push(`  - ${r.raw}`);
      }
    }
  }
  lines.push("", `(issuer: ${task.issuer}; details: read_file tasks/${task.id}/task.json)`);
  return lines.join("\n");
}

function formatStateChangeMessage(
  task: TaskFile,
  from: TaskBoardStatus,
  to: TaskBoardStatus,
  reason?: string,
): string {
  const lines: string[] = [];
  // Three terminal statuses (death boundary):
  if (to === "completed") {
    lines.push(`🌟 Task completed: ${task.title} (id=${task.id}) — all stages approved, archived.`);
  } else if (to === "closed") {
    lines.push(`🛑 Task closed: ${task.title} (id=${task.id}) — archived without success.`);
  } else if (to === "failed") {
    lines.push(`💔 Task failed: ${task.title} (id=${task.id}) — archived as failure.`);
  // Live transitions:
  } else if (to === "ready") {
    lines.push(`🟢 Task ready to start: ${task.title} (id=${task.id})`);
  } else if (to === "active") {
    lines.push(`▶️ Task active: ${task.title} (id=${task.id})`);
  } else if (to === "blocked") {
    lines.push(`⏸ Task blocked: ${task.title} (id=${task.id})`);
  } else {
    lines.push(`🔄 ${task.title} (id=${task.id}): ${from} → ${to}`);
  }
  if (reason) lines.push(`reason: ${reason}`);
  lines.push(`(issuer: ${task.issuer}; details: read_file tasks/${task.id}/)`);
  return lines.join("\n");
}

function formatContentChangeMessage(
  task: TaskFile,
  fields_changed: string[],
  reason?: string,
): string {
  const lines: string[] = [];
  lines.push(`✏️ Task updated: ${task.title} (id=${task.id})`);
  lines.push(`fields changed: ${fields_changed.join(", ")}`);
  if (reason) lines.push(`reason: ${reason}`);
  lines.push(`(issuer: ${task.issuer}; details: read_file tasks/${task.id}/)`);
  return lines.join("\n");
}

// ─── public push API ──────────────────────────────────────────────────────────

/**
 * Publish: notify the broadcast circle (notify-resolved real agents).
 * Refs containing `@task:<id>` of closed tasks are auto-expanded into the message body.
 */
export function notifyPublish(ctx: AgentContext, task: TaskFile): void {
  const expanded = expandRefs(task.refs, ctx);
  emitTaskNotifyHook(ctx, "published", task, {
    refs_expanded: expanded,
  });

  const { realAgents, extensionIds, channels } = resolveNotify(task.notify, ctx.tree, task.issuer);
  const body = formatPublishMessage(task, expanded);

  for (const agentId of realAgents) {
    if (agentId === ctx.agentId) continue;
    pushTaskMessage(ctx, agentId, body);
  }

  if (extensionIds.length > 0 || channels.length > 0) {
    emitTaskNotifyHook(ctx, "published_extension_audience", task, {
      extension_ids: extensionIds,
      channels,
    });
  }
}

/**
 * State change: notify the work circle (participants).
 * For TERMINAL transitions (completed / closed / failed) the death broadcast
 * also reaches the notify circle so external observers learn the task is over.
 *
 * NEVER pushes to the issuer. Rationale: state changes are always issuer-driven
 * (update_task) or driven by their own plugins (task_gate_watcher running in the
 * issuer's process) — the issuer either initiated the change or owns the actor,
 * and sees status via the board-view slot on their next turn. Pushing the echo
 * back is pure self-noise.
 */
export function notifyStateChange(
  ctx: AgentContext,
  task: TaskFile,
  state: TaskState,
  from: TaskBoardStatus,
  to: TaskBoardStatus,
  reason?: string,
): void {
  emitTaskNotifyHook(ctx, "state_change", task, { from, to, reason });

  const recipients = new Set<string>(state.participants);

  if (to === "completed" || to === "closed" || to === "failed") {
    const { realAgents, extensionIds, channels } = resolveNotify(task.notify, ctx.tree, task.issuer);
    for (const a of realAgents) recipients.add(a);
    if (extensionIds.length > 0 || channels.length > 0) {
      emitTaskNotifyHook(ctx, `${to}_extension_audience`, task, {
        extension_ids: extensionIds,
        channels,
      });
    }
  }

  // Issuer never receives the echo — they drove it (or own the watcher) and read board-view themselves.
  recipients.delete(task.issuer);
  // Belt-and-suspenders: also skip the emitter (e.g. if a plugin runs as a non-issuer agent).
  recipients.delete(ctx.agentId);

  const body = formatStateChangeMessage(task, from, to, reason);
  for (const agentId of recipients) {
    pushTaskMessage(ctx, agentId, body);
  }
}

/** Content increment (refs / description / gates / notify / extensions / priority / stages) → participants only. */
export function notifyContentChange(
  ctx: AgentContext,
  task: TaskFile,
  state: TaskState,
  fields_changed: string[],
  reason?: string,
): void {
  emitTaskNotifyHook(ctx, "content_change", task, { fields_changed, reason });
  if (fields_changed.length === 0 || state.participants.length === 0) return;

  const body = formatContentChangeMessage(task, fields_changed, reason);
  for (const agentId of state.participants) {
    if (agentId === ctx.agentId) continue;
    pushTaskMessage(ctx, agentId, body);
  }
}

// ─── stage-level pushes ─────────────────────────────────────────────────────

function stageHeader(task: TaskFile, stageIndex: number): string {
  const total = task.stages.length;
  const stage = task.stages[stageIndex];
  return `❖ [${task.title}] stage ${stageIndex + 1}/${total} — ${stage?.name ?? "(unknown)"}`;
}

function formatStageEnterMessage(
  task: TaskFile,
  stage: Stage,
  stageIndex: number,
  reason?: string,
  previousStageIndex?: number,
): string {
  const lines: string[] = [];

  // Advance scenario: explicitly echo "previous stage approved" before announcing the new one,
  // so participants see the full transition (✓ N approved → ▶ N+1 started) in one push.
  if (previousStageIndex !== undefined) {
    const prevStage = task.stages[previousStageIndex];
    if (prevStage) {
      lines.push(
        `✓ stage ${previousStageIndex + 1}/${task.stages.length} '${prevStage.name}' approved`,
        "",
        `▶ advancing to ${stageHeader(task, stageIndex)}`,
      );
    } else {
      lines.push(stageHeader(task, stageIndex));
    }
  } else {
    lines.push(`▶ ${stageHeader(task, stageIndex)}`);
  }

  lines.push("", stage.description);
  if (stage.refs && stage.refs.length > 0) {
    lines.push("", "refs:");
    for (const r of stage.refs) lines.push(`  - ${r}`);
  }
  if (stage.completion_criteria) {
    lines.push("", `completion criteria: ${stage.completion_criteria}`);
  }
  if (reason) lines.push("", `issuer note: ${reason}`);
  lines.push("", `(when done: complete_stage(task_id="${task.id}"))`);
  return lines.join("\n");
}

function formatStageRedoMessage(task: TaskFile, stage: Stage, stageIndex: number, reason?: string): string {
  const lines: string[] = [`🔄 stage 需要重做：${stageHeader(task, stageIndex)}`];
  if (reason) lines.push("", `issuer feedback: ${reason}`);
  lines.push("", stage.description);
  if (stage.completion_criteria) {
    lines.push("", `completion criteria: ${stage.completion_criteria}`);
  }
  lines.push("", `(re-do then: complete_stage(task_id="${task.id}"))`);
  return lines.join("\n");
}

function formatStageCompletedMessage(
  task: TaskFile,
  stage: Stage,
  stageIndex: number,
  participantId: string,
): string {
  const total = task.stages.length;
  const isLast = stageIndex === total - 1;
  const lines: string[] = [
    `✅ ${participantId} completed stage ${stageIndex + 1}/${total} — ${stage.name}`,
    `task: ${task.title} (id=${task.id})`,
  ];
  if (isLast) {
    lines.push("", "This is the LAST stage. Advance → task is archived as `completed` (terminal). Redo → re-do this stage.");
  } else {
    lines.push("", `Next stage on advance: ${stageIndex + 2}/${total} — ${task.stages[stageIndex + 1]?.name ?? "(unknown)"}`);
  }
  lines.push(
    "",
    `Decide:`,
    `  approve  → update_task(task_id="${task.id}", stage_action="advance", reason?)`,
    `  redo     → update_task(task_id="${task.id}", stage_action="redo", reason)`,
  );
  return lines.join("\n");
}

/**
 * Stage entered: pushed to ALL participants when issuer advances into stage N
 * (or initial entry on ready→active).
 *
 * When `previousStageIndex` is provided (advance scenario), the message body
 * explicitly echoes "✓ stage N approved → ▶ stage N+1 started" so participants
 * see the full transition in one push, not just an isolated "new stage" signal.
 */
export function notifyStageEnter(
  ctx: AgentContext,
  task: TaskFile,
  state: TaskState,
  stageIndex: number,
  reason?: string,
  previousStageIndex?: number,
): void {
  const stage = task.stages[stageIndex];
  if (!stage) return;
  emitTaskNotifyHook(ctx, "stage_enter", task, {
    stage_index: stageIndex,
    stage_name: stage.name,
    reason,
    previous_stage_index: previousStageIndex,
  });

  const body = formatStageEnterMessage(task, stage, stageIndex, reason, previousStageIndex);
  for (const agentId of state.participants) {
    if (agentId === ctx.agentId) continue;
    pushTaskMessage(ctx, agentId, body);
  }
}

/** Stage completed: pushed to issuer for review (advance / redo decision). */
export function notifyStageCompleted(
  ctx: AgentContext,
  task: TaskFile,
  _state: TaskState,
  stageIndex: number,
  participantId: string,
): void {
  const stage = task.stages[stageIndex];
  if (!stage) return;
  emitTaskNotifyHook(ctx, "stage_completed", task, {
    stage_index: stageIndex,
    stage_name: stage.name,
    by: participantId,
  });

  if (task.issuer === ctx.agentId) return; // issuer triggered themselves — no self-noise
  const body = formatStageCompletedMessage(task, stage, stageIndex, participantId);
  pushTaskMessage(ctx, task.issuer, body);
}

/** Stage redo: pushed to participants when issuer rejects current stage and asks for re-work. */
export function notifyStageRedo(
  ctx: AgentContext,
  task: TaskFile,
  state: TaskState,
  stageIndex: number,
  reason?: string,
): void {
  const stage = task.stages[stageIndex];
  if (!stage) return;
  emitTaskNotifyHook(ctx, "stage_redo", task, { stage_index: stageIndex, stage_name: stage.name, reason });

  const body = formatStageRedoMessage(task, stage, stageIndex, reason);
  for (const agentId of state.participants) {
    if (agentId === ctx.agentId) continue;
    pushTaskMessage(ctx, agentId, body);
  }
}
