// @desc Inject active plan body into context during execution — reads directly from file
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { findPendingPlans, scanPlansSync, readPlanFileSync } from "../lib/plan-files.js";

const create: SlotFactory = (ctx) => ({
  name: "active-plan",
  priority: SlotPriority.DYNAMIC_CONTEXT,
  cacheHint: "dynamic",
  content: () => {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    // Prefer the explicitly active plan over first pending
    const activeName = ctx.teamBoard.get(ctx.agentId, "ACTIVE_PLAN_NAME") as string | undefined;
    let plan = activeName
      ? scanPlansSync(homeDir).find((p) => p.name === activeName && p.status === "plan")
      : undefined;
    if (!plan) {
      const pending = findPendingPlans(homeDir);
      if (pending.length === 0) return "";
      plan = pending[0];
    }
    let content = readPlanFileSync(plan);
    if (!content) return "";

    // Strip ## Todos section — runtime todos are shown by the todos slot
    const todosIdx = content.indexOf("\n## Todos");
    if (todosIdx !== -1) content = content.slice(0, todosIdx).trimEnd();

    return [
      `## Active Plan: ${plan.name}`,
      "",
      content,
      "",
      "_Use \\`complete_plan\\` when all tasks are done, or \\`complete_plan(redo)\\` to mark as failed and rethink._",
    ].join("\n");
  },
  version: 0,
  condition: (c) => {
    const inPlanMode = c.teamBoard.get(c.agentId, TEAMBOARD_KEYS.STATUS) === "plan_mode";
    if (inPlanMode) return false;
    const homeDir = c.teamBoard.get(c.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    const activeName = c.teamBoard.get(c.agentId, "ACTIVE_PLAN_NAME") as string | undefined;
    if (activeName) {
      return scanPlansSync(homeDir).some((p) => p.name === activeName && p.status === "plan");
    }
    return findPendingPlans(homeDir).length > 0;
  },
});

export default create;
