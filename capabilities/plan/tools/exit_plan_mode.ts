// @desc Exit plan_mode without executing a plan — discard draft and return to normal
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { WORKSPACE_BOARD_KEY } from "../../workspace/condition.js";

export default {
  name: "exit_plan_mode",
  description:
    "Exit plan mode without executing a plan. Returns to normal operation. " +
    "Any draft plan remains as a .plan.md file on disk (can be executed later).",
  guidance:
    "**exit_plan_mode**: Use when you no longer need planning — task became simple, user changed direction, " +
    "or you want to abandon the current planning session. Draft plan files stay on disk.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  condition(ctx) {
    return ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) === "plan_mode";
  },
  formatDisplay() {
    return "exit_plan_mode";
  },
  async execute(_args, ctx): Promise<ToolOutput> {
    ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEYS.STATUS, "", { persist: true });
    ctx.teamBoard.remove(ctx.agentId, WORKSPACE_BOARD_KEY);

    return "Exited plan_mode. Back to normal operation. Draft plan files remain on disk.";
  },
} satisfies ToolDefinition;
