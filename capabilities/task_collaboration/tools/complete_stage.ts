// @desc Mark the current stage of a task you participate in as completed (stage_status: active → completed). Wakes issuer for advance/redo decision.

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  withTaskLock,
  taskExists,
  readTaskFile,
  readTaskState,
  writeTaskState,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { hasActiveStage } from "../lib/role-checks.js";
import { notifyStageCompleted } from "../lib/push-notifier.js";

export default {
  name: "complete_stage",
  description:
    "Mark the current STAGE (not the whole task) as completed. " +
    "This sets stage_status: active → completed and wakes the issuer for an advance/redo decision. " +
    "You stay in the task; if there are more stages, the issuer will advance you into the next one. " +
    "Final stage advance archives the whole task as `completed` (terminal) — no further close needed.",
  guidance:
    "Use this when you've genuinely finished what the current stage description asks for. " +
    "Don't use this for partial-progress reports — for those use send_message(scope.progress=true). " +
    "After completion: stop and wait for issuer's decision (advance to next stage, or redo with feedback). " +
    "If you have a question or need clarification mid-stage, use send_message(to=[issuer], scope={task_id, ...}) instead.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      summary: {
        type: "string",
        description: "Optional 1-2 sentence summary of what you did this stage (logged + included in the issuer push).",
      },
    },
    required: ["task_id"],
  },
  condition: (ctx) => hasActiveStage(ctx.pathManager, ctx.agentId),
  async execute(args, ctx): Promise<ToolOutput> {
    const taskId = String(args.task_id ?? "").trim();
    if (!taskId) return "Error: task_id is required";
    if (!taskExists(ctx.pathManager, taskId)) return `Error: task '${taskId}' not found`;

    const summary = args.summary != null ? String(args.summary).trim() : undefined;

    return await withTaskLock(taskId, async (): Promise<string> => {
      const task = readTaskFile(ctx.pathManager, taskId);
      const state = readTaskState(ctx.pathManager, taskId);

      if (state.status !== "active") {
        return `Error: task '${taskId}' is not active (current status: '${state.status}')`;
      }
      if (!state.participants.includes(ctx.agentId)) {
        return `Error: '${ctx.agentId}' is not a participant of '${taskId}'`;
      }
      if (state.stage_status !== "active") {
        return `Error: current stage_status is '${state.stage_status}' (must be 'active'). ${
          state.stage_status === "completed"
            ? "You already completed this stage; wait for issuer to advance or redo."
            : ""
        }`;
      }

      const stageIndex = state.current_stage;
      const stage = task.stages[stageIndex];
      if (!stage) {
        return `Error: current_stage index ${stageIndex} out of bounds (stages.length=${task.stages.length})`;
      }

      const next = { ...state, stage_status: "completed" as const };
      writeTaskState(ctx.pathManager, taskId, next);

      appendTaskLog(ctx.pathManager, taskId, {
        type: "stage_complete",
        stage_index: stageIndex,
        stage_name: stage.name,
        agentId: ctx.agentId,
      });
      if (summary) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "message",
          from: ctx.agentId,
          to: [task.issuer],
          progress: true,
          content: `[stage ${stageIndex + 1}/${task.stages.length} '${stage.name}' completed] ${summary}`,
        });
      }

      notifyStageCompleted(ctx, task, next, stageIndex, ctx.agentId);

      const total = task.stages.length;
      return `Stage ${stageIndex + 1}/${total} '${stage.name}' marked completed. Issuer (${task.issuer}) notified — wait for advance/redo decision.${summary ? ` Summary: ${summary}` : ""}`;
    });
  },
  serial: true,
} satisfies ToolDefinition;
