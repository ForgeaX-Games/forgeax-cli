// @desc Issuer-only forced adjustment of state.participants — bypasses eligibility (issuer endorses by act of adjustment).

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  withTaskLock,
  taskExists,
  readTaskFile,
  readTaskState,
  writeTaskState,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { hasIssuingTasks } from "../lib/role-checks.js";
import { TASK_TERMINAL_STATUSES, type TaskBoardStatus } from "../lib/task-types.js";
import { pushTaskMessage } from "../lib/push-notifier.js";

export default {
  name: "adjust_participants",
  description:
    "Issuer-only force-adjust of state.participants. Bypasses the notify-scope check — the act of adjusting IS the issuer's endorsement. " +
    "Use when you want to lock specific participants without waiting for their voluntary join_task — e.g. after chat agreement " +
    "that some agent + player will take a side quest, publish the task then directly add both into participants.",
  guidance:
    "Pass `add` and/or `remove` arrays of agent IDs. Status side-effects mirror join_task / leave_task: " +
    "first add on `posted` → `claiming`; last remove on `claiming` → `posted`; remove on `ready` → `claiming` (gates re-evaluate). " +
    "Cannot adjust on terminal status. Adjusted agents receive a one-line push letting them know.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      add: { type: "array", items: { type: "string" }, description: "Agent IDs to add to state.participants." },
      remove: { type: "array", items: { type: "string" }, description: "Agent IDs to remove from state.participants." },
      reason: { type: "string", description: "Optional human-readable reason; written to log.jsonl and notify body." },
    },
    required: ["task_id"],
  },
  // Visible only to agents who issue at least one live task — saves tool-list noise for non-issuers.
  condition: (ctx) => hasIssuingTasks(ctx.pathManager, ctx.agentId),
  async execute(args, ctx): Promise<ToolOutput> {
    const taskId = String(args.task_id ?? "").trim();
    if (!taskId) return "Error: task_id is required";
    if (!taskExists(ctx.pathManager, taskId)) return `Error: task '${taskId}' not found`;

    const add = Array.isArray(args.add) ? (args.add as unknown[]).map(String).filter(Boolean) : [];
    const remove = Array.isArray(args.remove) ? (args.remove as unknown[]).map(String).filter(Boolean) : [];
    if (add.length === 0 && remove.length === 0) {
      return "Error: must specify at least one of `add` or `remove`";
    }

    return await withTaskLock(taskId, async (): Promise<string> => {
      const task = readTaskFile(ctx.pathManager, taskId);
      const state = readTaskState(ctx.pathManager, taskId);

      if (task.issuer !== ctx.agentId) {
        return `Error: only the issuer ('${task.issuer}') can adjust participants of '${taskId}'`;
      }
      if (TASK_TERMINAL_STATUSES.has(state.status)) {
        return `Error: task '${taskId}' is in terminal status '${state.status}' — cannot adjust`;
      }

      const memberSet = new Set(state.participants);
      const addedActually: string[] = [];
      const removedActually: string[] = [];

      for (const id of add) {
        if (!memberSet.has(id)) {
          memberSet.add(id);
          addedActually.push(id);
        }
      }
      for (const id of remove) {
        if (memberSet.has(id)) {
          memberSet.delete(id);
          removedActually.push(id);
        }
      }
      if (addedActually.length === 0 && removedActually.length === 0) {
        return `No-op: all requested adjustments were already in effect for '${taskId}'.`;
      }

      const next = { ...state, participants: Array.from(memberSet) };

      // Status side-effects mirror join_task / leave_task transitions.
      let statusChange: { from: TaskBoardStatus; to: TaskBoardStatus } | undefined;
      if (state.status === "posted" && next.participants.length > 0) {
        next.status = "claiming";
        statusChange = { from: "posted", to: "claiming" };
      } else if (state.status === "claiming" && next.participants.length === 0) {
        next.status = "posted";
        statusChange = { from: "claiming", to: "posted" };
      } else if (state.status === "ready" && removedActually.length > 0) {
        next.status = "claiming";
        statusChange = { from: "ready", to: "claiming" };
      }

      writeTaskState(ctx.pathManager, taskId, next);

      // Reuse existing join / leave log types so downstream readers (board-view, replay) stay simple.
      for (const id of addedActually) {
        appendTaskLog(ctx.pathManager, taskId, { type: "join", agentId: id });
      }
      for (const id of removedActually) {
        appendTaskLog(ctx.pathManager, taskId, { type: "leave", agentId: id });
      }
      if (statusChange) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "state_change",
          from: statusChange.from,
          to: statusChange.to,
          actor: ctx.agentId,
          reason: args.reason ? `adjust_participants: ${args.reason}` : "adjust_participants",
        });
      }

      // Direct push to affected agents — short, attributing the issuer.
      const reason = args.reason ? String(args.reason) : "";
      for (const id of addedActually) {
        const body =
          `📥 You've been added as a participant of "${task.title}" (id=${task.id}) by issuer ${ctx.agentId}.` +
          (reason ? `\nreason: ${reason}` : "") +
          `\n(details: read_file tasks/${task.id}/)`;
        pushTaskMessage(ctx, id, body);
      }
      for (const id of removedActually) {
        const body =
          `📤 You've been removed from "${task.title}" (id=${task.id}) by issuer ${ctx.agentId}.` +
          (reason ? `\nreason: ${reason}` : "");
        pushTaskMessage(ctx, id, body);
      }

      const summary: string[] = [`Adjusted '${taskId}' participants. Total: ${next.participants.length}.`];
      if (addedActually.length > 0) summary.push(`added: [${addedActually.join(", ")}]`);
      if (removedActually.length > 0) summary.push(`removed: [${removedActually.join(", ")}]`);
      if (statusChange) summary.push(`status: ${statusChange.from} → ${statusChange.to}`);
      return summary.join(" ");
    });
  },
  serial: true,
} satisfies ToolDefinition;
