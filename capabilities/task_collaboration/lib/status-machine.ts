// @desc Task status transition table + validator.

import type { TaskBoardStatus } from "./task-types.js";

/**
 * Allowed transitions for the task-level `status` (state.json).
 *
 * Three PARALLEL terminal statuses — completed / closed / failed — are absorbing:
 * once entered the task is archived, no transitions out, filtered from live slots.
 *
 *   - completed : reached only via final stage advance (reserved transition)
 *   - closed    : issuer-driven archive without success (abandoned / superseded)
 *   - failed    : task ended in failure (irrecoverable / participant unable to deliver)
 *
 * Within `active`, the per-stage `stage_status` (pending/active/completed) is a
 * sub-state-machine driven by complete_stage / update_task(stage_action=...);
 * those transitions are tracked in stage-action helpers, not here.
 */
const ALLOWED: Record<TaskBoardStatus, ReadonlySet<TaskBoardStatus>> = {
  draft: new Set<TaskBoardStatus>(["posted", "closed", "failed"]),
  posted: new Set<TaskBoardStatus>(["claiming", "closed", "failed"]),
  claiming: new Set<TaskBoardStatus>(["posted", "ready", "closed", "failed"]),
  ready: new Set<TaskBoardStatus>(["active", "claiming", "closed", "failed"]),
  active: new Set<TaskBoardStatus>(["completed", "blocked", "closed", "failed"]),
  blocked: new Set<TaskBoardStatus>(["active", "closed", "failed"]),
  // terminal — no transitions out
  completed: new Set<TaskBoardStatus>(),
  closed: new Set<TaskBoardStatus>(),
  failed: new Set<TaskBoardStatus>(),
};

export function isAllowedTransition(from: TaskBoardStatus, to: TaskBoardStatus): boolean {
  return ALLOWED[from].has(to);
}

/** Returns null if allowed, otherwise an error message string. */
export function validateTransition(from: TaskBoardStatus, to: TaskBoardStatus): string | null {
  if (from === to) return `status already '${from}'`;
  if (!isAllowedTransition(from, to)) {
    return `illegal status transition: ${from} → ${to}`;
  }
  return null;
}

/**
 * Reserved transitions that cannot be invoked by update_task(status=...) — they
 * are owned by other components or driven implicitly:
 *  - posted → claiming: implicit via join_task (first joiner)
 *  - claiming → posted: implicit via leave_task fallback (last leaver)
 *  - claiming → ready:  automatic via task_gate_watcher (gates pass)
 *  - ready → claiming:  implicit via leave_task fallback (drops below gate threshold)
 *  - active → completed: only via update_task(stage_action="advance") on the LAST stage.
 *                       Issuer cannot directly set status=completed — success archive
 *                       must come from finishing all stages.
 */
const RESERVED_TRANSITIONS: ReadonlyArray<readonly [TaskBoardStatus, TaskBoardStatus]> = [
  ["posted", "claiming"],
  ["claiming", "posted"],
  ["claiming", "ready"],
  ["ready", "claiming"],
  ["active", "completed"],
];

export function isReservedTransition(from: TaskBoardStatus, to: TaskBoardStatus): boolean {
  return RESERVED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Validate a transition driven by update_task (combines isAllowed + reserved). */
export function validateUpdateTransition(from: TaskBoardStatus, to: TaskBoardStatus): string | null {
  const err = validateTransition(from, to);
  if (err) return err;
  if (isReservedTransition(from, to)) {
    return `transition ${from} → ${to} is reserved (driven by join_task / leave_task / task_gate_watcher / stage_action), not update_task(status)`;
  }
  return null;
}
