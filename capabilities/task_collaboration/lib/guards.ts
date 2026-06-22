// @desc Pure permission helpers for tools and slots.

import type { AgentTreeAPI } from "#src/core/types.js";
import type { TaskFile, TaskState } from "./task-types.js";
import { resolveNotify } from "./task-scope.js";

/** True if viewer can see this task in their board-tasks slot. */
export function canViewTask(
  task: TaskFile,
  state: TaskState,
  viewerId: string,
  tree: AgentTreeAPI,
): boolean {
  if (task.issuer === viewerId) return true;
  if (state.participants.includes(viewerId)) return true;
  const { realAgents } = resolveNotify(task.notify, tree, task.issuer);
  return realAgents.includes(viewerId);
}

/**
 * True if viewer can join this task. Notify scope IS join eligibility:
 * any agent resolved by `task.notify` (children_depth BFS / agentIds / groupIds)
 * may join. Issuer cannot self-join (resolveNotify excludes the issuer).
 * Issuer can force-add anyone via adjust_participants (bypasses this check).
 */
export function canJoinTask(
  task: TaskFile,
  viewerId: string,
  tree: AgentTreeAPI,
): boolean {
  const { realAgents } = resolveNotify(task.notify, tree, task.issuer);
  return realAgents.includes(viewerId);
}

/** True if viewer is a participant of this task and may leave. */
export function canLeaveTask(state: TaskState, viewerId: string): boolean {
  return state.participants.includes(viewerId);
}

/** True if viewer is the issuer (only authority to update / cancel / close). */
export function canUpdateTask(task: TaskFile, viewerId: string): boolean {
  return task.issuer === viewerId;
}
