// @desc Per-turn role checks for tool inline conditions: classify an agent's relationship to live tasks.
//
// Three orthogonal predicates, mapping directly to the three audience layers of a task:
//
//   issuer       — agent published this task (only one per task; controls update_task lifecycle)
//   notified     — agent appears in the resolved real-agents set of `task.notify` (broadcast circle)
//   participant  — agent is in `state.participants` (work circle, can leave / push progress)
//
// Combined predicate `hasInvolvedTasks` = issuer ∨ notified ∨ participant — used to gate
// tools / slots that only make sense when the agent has *some* live task in scope.

import type { AgentTreeAPI, PathManagerAPI } from "#src/core/types.js";
import { listAllTasks } from "./task-board.js";
import { resolveNotify } from "./task-scope.js";
import { TASK_TERMINAL_STATUSES } from "./task-types.js";

/** Agent has at least one non-terminal task they issued. Gates: update_task, board-view slot. */
export function hasIssuingTasks(pm: PathManagerAPI, agentId: string): boolean {
  for (const t of listAllTasks(pm)) {
    if (TASK_TERMINAL_STATUSES.has(t.state.status)) continue;
    if (t.task.issuer === agentId) return true;
  }
  return false;
}

/** Agent is in the resolved notify set of at least one non-terminal task (i.e. broadcasted to). */
export function hasNotifiedTasks(pm: PathManagerAPI, agentId: string, tree: AgentTreeAPI): boolean {
  for (const t of listAllTasks(pm)) {
    if (TASK_TERMINAL_STATUSES.has(t.state.status)) continue;
    if (t.task.issuer === agentId) continue; // issuer is on the work-circle, not broadcast
    const { realAgents } = resolveNotify(t.task.notify, tree, t.task.issuer);
    if (realAgents.includes(agentId)) return true;
  }
  return false;
}

/** Agent is a participant of at least one non-terminal task. Gates: leave_task. */
export function hasParticipatingTasks(pm: PathManagerAPI, agentId: string): boolean {
  for (const t of listAllTasks(pm)) {
    if (TASK_TERMINAL_STATUSES.has(t.state.status)) continue;
    if (t.state.participants.includes(agentId)) return true;
  }
  return false;
}

/**
 * Agent is a participant of an active task whose current stage is in `active`
 * stage_status — i.e. there exists a stage they can mark complete right now.
 * Gates: complete_stage tool visibility.
 */
export function hasActiveStage(pm: PathManagerAPI, agentId: string): boolean {
  for (const t of listAllTasks(pm)) {
    if (t.state.status !== "active") continue;
    if (t.state.stage_status !== "active") continue;
    if (t.state.participants.includes(agentId)) return true;
  }
  return false;
}

/** Union: issuer ∨ notified ∨ participant. Gates: join_task, board-tasks slot. */
export function hasInvolvedTasks(pm: PathManagerAPI, agentId: string, tree: AgentTreeAPI): boolean {
  for (const t of listAllTasks(pm)) {
    if (TASK_TERMINAL_STATUSES.has(t.state.status)) continue;
    if (t.task.issuer === agentId) return true;
    if (t.state.participants.includes(agentId)) return true;
    const { realAgents } = resolveNotify(t.task.notify, tree, t.task.issuer);
    if (realAgents.includes(agentId)) return true;
  }
  return false;
}
