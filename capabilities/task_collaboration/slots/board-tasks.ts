// @desc Slot: live task list for participants / notify-circle viewers (id/title/status + stage cursor when active + gate progress when posted/claiming).

import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { listAllTasks, type TaskSummary } from "../lib/task-board.js";
import { canViewTask } from "../lib/guards.js";
import { renderGateProgress } from "../lib/gate-evaluator.js";
import { TASK_TERMINAL_STATUSES } from "../lib/task-types.js";

function firstLine(text: string | undefined, max = 80): string {
  if (!text) return "";
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

const create: SlotFactory = (ctx) => ({
  name: "board-tasks",
  priority: SlotPriority.DYNAMIC_CONTEXT,
  cacheHint: "dynamic",
  version: 0,
  content: () => {
    let summaries: TaskSummary[];
    try {
      summaries = listAllTasks(ctx.pathManager);
    } catch {
      return "";
    }

    const visible = summaries.filter(s => {
      if (TASK_TERMINAL_STATUSES.has(s.state.status)) return false;
      if (s.task.issuer === ctx.agentId) return false;  // issuer view → board-view
      return canViewTask(s.task, s.state, ctx.agentId, ctx.tree);
    });

    if (visible.length === 0) return "";

    const lines: string[] = ["# board-tasks (your relevant tasks)"];
    for (const s of visible) {
      lines.push("");
      lines.push(`#${s.id} [${s.state.status}] "${s.task.title}" (issuer: ${s.task.issuer})`);
      if (s.state.participants.length > 0) {
        lines.push(`  participants: [${s.state.participants.join(", ")}]`);
      }

      // Stage cursor (only meaningful when active; terminal tasks are filtered above)
      if (s.state.status === "active") {
        const total = s.task.stages.length;
        const idx = s.state.current_stage;
        const stage = s.task.stages[idx];
        if (stage) {
          lines.push(`  stage ${idx + 1}/${total} '${stage.name}' [${s.state.stage_status}]`);
          const desc = firstLine(stage.description);
          if (desc) lines.push(`    ${desc}`);
        }
      }

      if ((s.state.status === "posted" || s.state.status === "claiming") && s.state.gate_progress) {
        lines.push("  gates:");
        const rendered = renderGateProgress(s.state.gate_progress, "    ");
        lines.push(rendered);
      }
    }
    return lines.join("\n");
  },
});

export default create;
