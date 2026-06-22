// @desc Update a task you issued: patch task.json fields (whitelist), advance status, drive stage_action, or write/delete gate scripts.

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  withTaskLock,
  taskExists,
  readTaskFile,
  readTaskState,
  writeTaskFile,
  writeTaskState,
  writeGateScript,
  deleteGateScript,
  ensureSafeGateFilename,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { applyTaskPatch } from "../lib/task-patch.js";
import { validateUpdateTransition } from "../lib/status-machine.js";
import { canUpdateTask } from "../lib/guards.js";
import { hasIssuingTasks } from "../lib/role-checks.js";
import {
  notifyStateChange,
  notifyContentChange,
  notifyStageEnter,
  notifyStageRedo,
} from "../lib/push-notifier.js";
import {
  TASK_TERMINAL_STATUSES,
  type TaskBoardStatus,
  type TaskFile,
  type TaskState,
} from "../lib/task-types.js";

const ALL_STATUSES: TaskBoardStatus[] = [
  "draft", "posted", "claiming", "ready", "active", "blocked", "completed", "closed", "failed",
];

type StageAction = "advance" | "redo";
const ALL_STAGE_ACTIONS: StageAction[] = ["advance", "redo"];

export default {
  name: "update_task",
  description:
    "Update a task you issued (issuer-only). One call can do any subset of: " +
    "patch task.json fields (whitelist) / transition status / drive stage_action / write|delete gate scripts. " +
    "id and issuer are immutable; state.current_stage and stage_status are NEVER touched by patch — only by stage_action.",
  guidance:
    "task: partial patch — allowed fields: title / description / notify / priority / refs / extensions / gates / stages. " +
    "Editing stages does NOT scramble execution; the cursor (state.current_stage) is independent. " +
    "status: legal transitions only. Three PARALLEL terminal statuses (no chain between them): " +
    "  completed = reached only via final stage advance (issuer cannot set directly); " +
    "  closed    = issuer-driven archive without success (abandoned / superseded / no-longer-needed); " +
    "  failed    = task ended in failure (irrecoverable / participant unable to deliver). " +
    "Reserved transitions are driven by other components (join_task / leave_task / task_gate_watcher / stage_action), not here. " +
    "stage_action='advance': only when current stage_status==='completed'. Last stage advance → task archived as `completed` (TERMINAL). " +
    "stage_action='redo': only when current stage_status==='completed'; reopens current stage for participant. " +
    "status and stage_action are mutually exclusive in one call. " +
    "ready → active: this is how a task starts; stage 0 enters `active` automatically and a stage_enter push is sent. " +
    "gates_files: map filename → content (write/replace) or null (delete). Filenames must match safe basename whitelist. " +
    "reason: human-readable explanation written to log.jsonl and included in pushes.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      task: {
        type: "object",
        description: "Partial patch on task.json. Allowed: title/description/notify/priority/refs/extensions/gates/stages.",
      },
      status: {
        type: "string",
        enum: ALL_STATUSES,
        description: "Status transition (state machine validates).",
      },
      stage_action: {
        type: "string",
        enum: ALL_STAGE_ACTIONS,
        description: "Drive the per-stage cursor: 'advance' (approve current stage, move on) or 'redo' (reopen current stage).",
      },
      gates_files: {
        type: "object",
        description: "Map of filename → content (write/replace) or null (delete). Filenames must match [A-Za-z0-9_.-]+\\.sh",
      },
      reason: { type: "string" },
    },
    required: ["task_id"],
  },
  condition: (ctx) => hasIssuingTasks(ctx.pathManager, ctx.agentId),
  async execute(args, ctx): Promise<ToolOutput> {
    const taskId = String(args.task_id ?? "").trim();
    if (!taskId) return "Error: task_id is required";
    if (!taskExists(ctx.pathManager, taskId)) return `Error: task '${taskId}' not found`;

    const reason = args.reason != null ? String(args.reason) : undefined;
    const patch = args.task as Partial<TaskFile> | undefined;
    const status = args.status as TaskBoardStatus | undefined;
    const stageAction = args.stage_action as StageAction | undefined;
    const gatesFiles = args.gates_files as Record<string, string | null> | undefined;

    if (patch === undefined && status === undefined && stageAction === undefined && gatesFiles === undefined) {
      return "Error: no-op (provide at least one of task / status / stage_action / gates_files)";
    }
    if (status !== undefined && stageAction !== undefined) {
      return "Error: status and stage_action are mutually exclusive in one call";
    }

    return await withTaskLock(taskId, async (): Promise<string> => {
      let task = readTaskFile(ctx.pathManager, taskId);
      let state = readTaskState(ctx.pathManager, taskId);

      if (!canUpdateTask(task, ctx.agentId)) {
        return `Error: only the issuer (${task.issuer}) can update_task '${taskId}'`;
      }
      if (TASK_TERMINAL_STATUSES.has(state.status)) {
        return `Error: task '${taskId}' is in terminal status '${state.status}'; cannot update`;
      }

      const fieldsChanged: string[] = [];

      // ── 1. Patch task.json (does NOT touch state.current_stage / stage_status) ──
      if (patch !== undefined) {
        const result = applyTaskPatch(task, patch);
        if (!result.ok) return `Error: ${result.error}`;
        task = result.result;
        for (const f of result.fields_changed) fieldsChanged.push(f);
      }

      // ── 2. gates_files write/delete ──
      const gateFilesChanged: string[] = [];
      if (gatesFiles !== undefined) {
        for (const filename of Object.keys(gatesFiles)) {
          try {
            ensureSafeGateFilename(filename);
          } catch (err) {
            return `Error: ${(err as Error).message}`;
          }
        }
        for (const [filename, content] of Object.entries(gatesFiles)) {
          if (content === null) {
            deleteGateScript(ctx.pathManager, taskId, filename);
            gateFilesChanged.push(`-${filename}`);
          } else {
            writeGateScript(ctx.pathManager, taskId, filename, String(content));
            gateFilesChanged.push(`+${filename}`);
          }
        }
        if (gateFilesChanged.length > 0) {
          fieldsChanged.push(`gates_files(${gateFilesChanged.join(",")})`);
        }
      }

      // ── 3. Status transition (mutually exclusive with stage_action) ──
      let statusChanged: { from: TaskBoardStatus; to: TaskBoardStatus } | undefined;
      let initializedStage0 = false;
      if (status !== undefined) {
        if (!ALL_STATUSES.includes(status)) return `Error: invalid status '${status}'`;
        const err = validateUpdateTransition(state.status, status);
        if (err) return `Error: ${err}`;
        statusChanged = { from: state.status, to: status };

        const next: TaskState = { ...state, status };
        if (status === "blocked") next.blockedFromStatus = statusChanged.from;
        if (statusChanged.from === "blocked" && status !== "blocked") delete next.blockedFromStatus;

        // Special: ready → active means "kick off stage 0".
        if (statusChanged.from === "ready" && status === "active") {
          next.current_stage = 0;
          next.stage_status = "active";
          initializedStage0 = true;
        }

        state = next;
      }

      // ── 4. stage_action (advance / redo) ──
      let stageEffect: { kind: "advance"; from_stage: number; to_stage: number; taskCompleted: boolean }
                     | { kind: "redo"; stage_index: number }
                     | undefined;
      if (stageAction !== undefined) {
        if (state.status !== "active") {
          return `Error: stage_action requires task.status === 'active' (current: '${state.status}')`;
        }
        if (state.stage_status !== "completed") {
          return `Error: stage_action requires current stage_status === 'completed' (current: '${state.stage_status}'). Wait for participant to complete_stage first.`;
        }
        const total = task.stages.length;
        const cur = state.current_stage;

        if (stageAction === "advance") {
          if (cur >= total - 1) {
            // Last stage approved → task archived as `completed` (terminal, no further close needed).
            state = { ...state, status: "completed" };
            stageEffect = { kind: "advance", from_stage: cur, to_stage: cur, taskCompleted: true };
          } else {
            state = { ...state, current_stage: cur + 1, stage_status: "active" };
            stageEffect = { kind: "advance", from_stage: cur, to_stage: cur + 1, taskCompleted: false };
          }
        } else {
          // redo
          state = { ...state, stage_status: "active" };
          stageEffect = { kind: "redo", stage_index: cur };
        }
      }

      // ── Persist ──
      if (patch !== undefined) writeTaskFile(ctx.pathManager, taskId, task);
      if (statusChanged || stageEffect) writeTaskState(ctx.pathManager, taskId, state);

      // ── Log ──
      if (statusChanged) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "state_change",
          from: statusChanged.from,
          to: statusChanged.to,
          actor: ctx.agentId,
          reason,
        });
      }
      if (fieldsChanged.length > 0) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "update",
          actor: ctx.agentId,
          fields_changed: fieldsChanged,
          reason,
        });
      }
      if (stageEffect?.kind === "advance") {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "stage_advance",
          from_stage: stageEffect.from_stage,
          to_stage: stageEffect.to_stage,
          actor: ctx.agentId,
          reason,
        });
        if (stageEffect.taskCompleted) {
          appendTaskLog(ctx.pathManager, taskId, {
            type: "state_change",
            from: "active",
            to: "completed",
            actor: ctx.agentId,
            reason: reason ?? "all stages approved — task archived as completed",
          });
        }
      } else if (stageEffect?.kind === "redo") {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "stage_redo",
          stage_index: stageEffect.stage_index,
          actor: ctx.agentId,
          reason,
        });
      }

      // ── Push ──
      if (statusChanged) {
        notifyStateChange(ctx, task, state, statusChanged.from, statusChanged.to, reason);
        if (initializedStage0) {
          notifyStageEnter(ctx, task, state, 0, reason);
        }
      } else if (fieldsChanged.length > 0 && stageEffect === undefined) {
        notifyContentChange(ctx, task, state, fieldsChanged, reason);
      }
      if (stageEffect?.kind === "advance") {
        if (stageEffect.taskCompleted) {
          notifyStateChange(ctx, task, state, "active", "completed", reason ?? "all stages approved");
        } else {
          // Pass previousStageIndex so participants see "✓ stage N approved → ▶ stage N+1 started"
          notifyStageEnter(ctx, task, state, stageEffect.to_stage, reason, stageEffect.from_stage);
        }
      } else if (stageEffect?.kind === "redo") {
        notifyStageRedo(ctx, task, state, stageEffect.stage_index, reason);
      }

      // ── Return summary ──
      const summary: string[] = [`Updated '${taskId}'`];
      if (statusChanged) summary.push(`status: ${statusChanged.from} → ${statusChanged.to}`);
      if (initializedStage0) {
        summary.push(`stage 1/${task.stages.length} '${task.stages[0]?.name}' active`);
      }
      if (stageEffect?.kind === "advance") {
        if (stageEffect.taskCompleted) {
          summary.push(`all ${task.stages.length} stages approved; task archived as completed (terminal)`);
        } else {
          summary.push(`stage advance ${stageEffect.from_stage + 1} → ${stageEffect.to_stage + 1}/${task.stages.length} '${task.stages[stageEffect.to_stage]?.name}'`);
        }
      } else if (stageEffect?.kind === "redo") {
        summary.push(`stage ${stageEffect.stage_index + 1} reopened (redo)`);
      }
      if (fieldsChanged.length > 0) summary.push(`fields: ${fieldsChanged.join(", ")}`);
      if (reason) summary.push(`reason: ${reason}`);
      return summary.join("; ");
    });
  },
  serial: true,
} satisfies ToolDefinition;
