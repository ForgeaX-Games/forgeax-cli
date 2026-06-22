// @desc Cross-task scanning helpers for slots / role-checks / pluginpolling. Reads task.json + state.json.

import type { PathManagerAPI } from "#src/core/types.js";
import { listTaskIds, readTaskFile, readTaskState, taskExists } from "./task-dir.js";
import { TASK_TERMINAL_STATUSES, type TaskFile, type TaskState, type TaskBoardStatus } from "./task-types.js";

export interface TaskSummary {
  id: string;
  task: TaskFile;
  state: TaskState;
}

export function listAllTasks(pm: PathManagerAPI): TaskSummary[] {
  const ids = listTaskIds(pm);
  const out: TaskSummary[] = [];
  for (const id of ids) {
    try {
      const task = readTaskFile(pm, id);
      let state: TaskState;
      try {
        state = readTaskState(pm, id);
      } catch {
        // state.json missing — treat as posted (write happens lazily on first transition)
        state = { status: "posted", participants: [], updatedAt: new Date().toISOString() };
      }
      out.push({ id, task, state });
    } catch {
      // Skip malformed task dirs
    }
  }
  return out;
}

export function listLiveTasks(pm: PathManagerAPI): TaskSummary[] {
  return listAllTasks(pm).filter(t => !TASK_TERMINAL_STATUSES.has(t.state.status));
}

export function listTasksByIssuer(pm: PathManagerAPI, issuer: string): TaskSummary[] {
  return listAllTasks(pm).filter(t => t.task.issuer === issuer);
}

export function listTasksByParticipant(pm: PathManagerAPI, agentId: string): TaskSummary[] {
  return listAllTasks(pm).filter(t => t.state.participants.includes(agentId));
}

export function listTasksByStatus(pm: PathManagerAPI, statuses: TaskBoardStatus[]): TaskSummary[] {
  const set = new Set(statuses);
  return listAllTasks(pm).filter(t => set.has(t.state.status));
}

export function loadTaskSummary(pm: PathManagerAPI, taskId: string): TaskSummary | null {
  if (!taskExists(pm, taskId)) return null;
  try {
    return { id: taskId, task: readTaskFile(pm, taskId), state: readTaskState(pm, taskId) };
  } catch {
    return null;
  }
}
