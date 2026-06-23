// @desc Join a task as a participant (writes state.json.participants; first joiner triggers posted → claiming).

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  withTaskLock,
  taskExists,
  readTaskFile,
  readTaskState,
  writeTaskState,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { canJoinTask } from "../lib/guards.js";
import { hasInvolvedTasks } from "../lib/role-checks.js";
import { TASK_TERMINAL_STATUSES, type TaskBoardStatus } from "../lib/task-types.js";

export default {
  name: "join_task",
  description:
    "Join a task as a participant. You'll be added to state.participants; if you're the first joiner the task transitions posted → claiming. " +
    "Eligibility (agentIds / groupIds / roles) is checked at join time. Doesn't wake any agent — issuer monitors progress via the slot.",
  guidance:
    "Use this when you see a task in your board-tasks slot that you want to take part in. " +
    "After joining, watch the task evolve: gates → ready → active. To leave, use leave_task.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
  },
  // Visible only when this agent already has *some* live task in scope —
  // either as issuer, in the notify circle, or as a current participant.
  // Reduces tool-list noise for agents with no task context.
  condition: (ctx) => hasInvolvedTasks(ctx.pathManager, ctx.agentId, ctx.tree),
  async execute(args, ctx): Promise<ToolOutput> {
    const taskId = String(args.task_id ?? "").trim();
    if (!taskId) return "Error: task_id is required";
    if (!taskExists(ctx.pathManager, taskId)) return `Error: task '${taskId}' not found`;

    return await withTaskLock(taskId, async (): Promise<string> => {
      const task = readTaskFile(ctx.pathManager, taskId);
      const state = readTaskState(ctx.pathManager, taskId);

      if (TASK_TERMINAL_STATUSES.has(state.status)) {
        return `Error: task '${taskId}' is in terminal status '${state.status}'`;
      }
      if (state.status === "active" || state.status === "blocked") {
        return `Error: task '${taskId}' is already in '${state.status}' — cannot join now`;
      }
      if (state.participants.includes(ctx.agentId)) {
        return `No-op: '${ctx.agentId}' is already a participant of '${taskId}'`;
      }
      if (!canJoinTask(task, ctx.agentId, ctx.tree)) {
        return (
          `Error: '${ctx.agentId}' is not in the notify scope of '${taskId}'. ` +
          `Issuer can pull you in via adjust_participants if needed.`
        );
      }

      const next = { ...state };
      next.participants = [...state.participants, ctx.agentId];

      let statusChange: { from: TaskBoardStatus; to: TaskBoardStatus } | undefined;
      if (state.status === "posted") {
        next.status = "claiming";
        statusChange = { from: "posted", to: "claiming" };
      }

      writeTaskState(ctx.pathManager, taskId, next);

      appendTaskLog(ctx.pathManager, taskId, {
        type: "join",
        agentId: ctx.agentId,
      });
      if (statusChange) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "state_change",
          from: statusChange.from,
          to: statusChange.to,
          actor: ctx.agentId,
          reason: "first joiner",
        });
      }

      return `Joined '${taskId}' as participant. Total: ${next.participants.length}.${
        statusChange ? ` Status: ${statusChange.from} → ${statusChange.to}.` : ""
      }`;
    });
  },
  serial: true,
} satisfies ToolDefinition;
