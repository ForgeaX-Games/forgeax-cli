// @desc Slot: issuer view — all NON-TERMINAL tasks issued by this agent, grouped by status, with stage cursor for active tasks. Terminal tasks (completed/closed/failed) are filtered out and never re-surface.

import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { listTasksByIssuer, type TaskSummary } from "../lib/task-board.js";
import { renderGateProgress } from "../lib/gate-evaluator.js";
import { TASK_TERMINAL_STATUSES, type TaskBoardStatus } from "../lib/task-types.js";

// Display order — only NON-TERMINAL statuses appear here (terminals filtered upstream).
// Live work (active) first because it most often demands attention; draft last.
const STATUS_ORDER: TaskBoardStatus[] = [
  "active", "ready", "blocked", "claiming", "posted", "draft",
];

const create: SlotFactory = (ctx) => ({
  name: "board-view",
  priority: SlotPriority.DYNAMIC_CONTEXT,
  cacheHint: "dynamic",
  version: 0,
  condition: (c) => {
    try {
      const tasks = listTasksByIssuer(c.pathManager, c.agentId);
      return tasks.some(t => !TASK_TERMINAL_STATUSES.has(t.state.status));
    } catch {
      return false;
    }
  },
  content: () => {
    let mine: TaskSummary[];
    try {
      mine = listTasksByIssuer(ctx.pathManager, ctx.agentId).filter(
        t => !TASK_TERMINAL_STATUSES.has(t.state.status),
      );
    } catch {
      return "";
    }
    if (mine.length === 0) return "";

    const grouped = new Map<TaskBoardStatus, TaskSummary[]>();
    for (const t of mine) {
      const arr = grouped.get(t.state.status) ?? [];
      arr.push(t);
      grouped.set(t.state.status, arr);
    }

    const lines: string[] = ["# board-view (tasks you issued)"];
    for (const status of STATUS_ORDER) {
      const arr = grouped.get(status);
      if (!arr || arr.length === 0) continue;
      lines.push("", `## [${status}] (${arr.length})`);
      for (const s of arr) {
        lines.push(`  #${s.id} "${s.task.title}"`);
        if (s.state.participants.length > 0) {
          lines.push(`    participants: [${s.state.participants.join(", ")}]`);
        }

        // Stage cursor for active tasks (terminals filtered above, no completed branch needed)
        if (status === "active") {
          const total = s.task.stages.length;
          const idx = s.state.current_stage;
          const stage = s.task.stages[idx];
          if (stage) {
            const flag = s.state.stage_status === "completed" ? "✓ awaiting your advance/redo" : "▶";
            lines.push(`    stage ${idx + 1}/${total} '${stage.name}' [${s.state.stage_status}] ${flag}`);
          }
        }

        if ((status === "posted" || status === "claiming") && s.state.gate_progress) {
          lines.push("    gates:");
          lines.push(renderGateProgress(s.state.gate_progress, "      "));
        }
      }
    }
    return lines.join("\n");
  },
});

export default create;
