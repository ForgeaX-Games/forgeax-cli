// @desc Enter plan_mode for focused planning before execution
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { WORKSPACE_BOARD_KEY } from "../../workspace/condition.js";

export default {
  name: "enter_plan_mode",
  description:
    "Enter plan mode for focused planning. Use this before starting a complex task that needs " +
    "structured decomposition. Once in plan mode you gain access to create_plan and review_plan. " +
    "File editing is disabled; shell and read tools remain available.",
  guidance:
    "**enter_plan_mode**: Use when a task has multiple valid approaches, touches many files, " +
    "or needs alignment before coding. Err on the side of planning.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  condition(ctx) {
    return ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) !== "plan_mode";
  },
  formatDisplay() {
    return "enter_plan_mode";
  },
  async execute(_args, ctx): Promise<ToolOutput> {
    const current = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) as string;
    if (current === "plan_mode") {
      return "Already in plan_mode.";
    }

    ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEYS.STATUS, "plan_mode", { persist: true });
    ctx.teamBoard.set(ctx.agentId, WORKSPACE_BOARD_KEY, "read-only", { persist: false });

    return (
      "Entered plan_mode. Workspace set to read-only (shell still available). " +
      "Explore the codebase thoroughly, then use `create_plan` to persist your plan."
    );
  },
} satisfies ToolDefinition;
