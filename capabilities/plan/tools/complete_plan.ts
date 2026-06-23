// @desc Mark the active plan as done or failed, clean up runtime state
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { findPendingPlans, renamePlanStatus } from "../lib/plan-files.js";

export default {
  name: "complete_plan",
  description:
    "Mark the current plan as complete (done) or failed (redo). " +
    "Renames the plan file. Todos are preserved for reference.",
  guidance:
    "**complete_plan**: Call when you've finished all tasks in the plan. " +
    "Default (no args) marks as done (.done.md). " +
    "Use `verdict: 'redo'` to mark as failed (.failed.md) — " +
    "this means the plan approach didn't work and should be rethought from scratch.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["done", "redo"],
        description:
          "Plan outcome. 'done' (default): plan completed successfully, file renamed to .done.md. " +
          "'redo': plan failed or needs a fundamentally different approach, file renamed to .failed.md. " +
          "A failed plan signals that the approach was wrong — next attempt should rethink the strategy.",
      },
    },
    required: [],
  },
  condition(ctx) {
    const inPlanMode = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) === "plan_mode";
    if (inPlanMode) return false;
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    return findPendingPlans(homeDir).length > 0;
  },
  formatDisplay(args) {
    return `complete_plan verdict=${String(args.verdict ?? "done")}`;
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    const pending = findPendingPlans(homeDir);
    if (pending.length === 0) return "Error: no active plan found.";

    const plan = pending[0];
    const verdict = String(args.verdict ?? "done") as "done" | "redo";
    const targetStatus = verdict === "redo" ? "failed" : "done";

    try {
      await renamePlanStatus(homeDir, plan.name, "plan", targetStatus);
    } catch {
      // File might have been manually moved — proceed with cleanup
    }

    // Clear active plan tracking
    ctx.teamBoard.remove(ctx.agentId, "ACTIVE_PLAN_NAME");

    if (verdict === "redo") {
      return (
        `Plan '${plan.name}' marked as failed (.failed.md). ` +
        `The approach didn't work — rethink the strategy before creating a new plan.`
      );
    }
    return `Plan '${plan.name}' completed (.done.md).`;
  },
} satisfies ToolDefinition;
