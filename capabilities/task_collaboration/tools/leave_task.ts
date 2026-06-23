// @desc Leave a task (remove self from state.json.participants; if status was 'ready', revert to 'claiming' for re-evaluation).

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  withTaskLock,
  taskExists,
  readTaskState,
  writeTaskState,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { canLeaveTask } from "../lib/guards.js";
import { hasParticipatingTasks } from "../lib/role-checks.js";
import { TASK_TERMINAL_STATUSES, type TaskBoardStatus } from "../lib/task-types.js";

export default {
  name: "leave_task",
  description:
    "Leave a task you've joined (removes you from state.participants). " +
    "If status was 'ready', reverts to 'claiming' so gates re-evaluate. If you were the last claiming participant, status reverts to 'posted'. Doesn't wake anyone.",
  guidance:
    "Voluntary withdrawal. Issuer can also force-archive via update_task(status=closed) or status=failed.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
  },
  condition: (ctx) => hasParticipatingTasks(ctx.pathManager, ctx.agentId),
  async execute(args, ctx): Promise<ToolOutput> {
    const taskId = String(args.task_id ?? "").trim();
    if (!taskId) return "Error: task_id is required";
    if (!taskExists(ctx.pathManager, taskId)) return `Error: task '${taskId}' not found`;

    return await withTaskLock(taskId, async (): Promise<string> => {
      const state = readTaskState(ctx.pathManager, taskId);

      if (TASK_TERMINAL_STATUSES.has(state.status)) {
        return `Error: task '${taskId}' is in terminal status '${state.status}'`;
      }
      if (!canLeaveTask(state, ctx.agentId)) {
        return `Error: '${ctx.agentId}' is not a participant of '${taskId}'`;
      }

      const next = { ...state };
      next.participants = state.participants.filter(id => id !== ctx.agentId);

      let statusChange: { from: TaskBoardStatus; to: TaskBoardStatus } | undefined;
      if (state.status === "ready") {
        next.status = "claiming";
        statusChange = { from: "ready", to: "claiming" };
      } else if (state.status === "claiming" && next.participants.length === 0) {
        next.status = "posted";
        statusChange = { from: "claiming", to: "posted" };
      }

      writeTaskState(ctx.pathManager, taskId, next);

      appendTaskLog(ctx.pathManager, taskId, {
        type: "leave",
        agentId: ctx.agentId,
      });
      if (statusChange) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "state_change",
          from: statusChange.from,
          to: statusChange.to,
          actor: ctx.agentId,
          reason: state.status === "ready" ? "participant left ready task" : "last participant left",
        });
      }

      return `Left '${taskId}'. Remaining participants: ${next.participants.length}.${
        statusChange ? ` Status: ${statusChange.from} → ${statusChange.to}.` : ""
      }`;
    });
  },
  serial: true,
} satisfies ToolDefinition;
