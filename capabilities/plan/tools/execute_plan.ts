// @desc Execute a plan: exit plan_mode, track active plan, dispatch todo_write via agent_command
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { WORKSPACE_BOARD_KEY } from "../../workspace/condition.js";
import { TODO_BOARD_KEY, type TodoItem } from "./create_plan.js";
import { findPendingPlans, parseTodosFromMarkdown, readPlanFileSync, renamePlanStatus } from "../lib/plan-files.js";

export default {
  name: "execute_plan",
  description:
    "Start executing a plan: exits plan_mode and begins work. " +
    "If another plan was already being executed, it is marked as failed.",
  guidance:
    "**execute_plan**: Call after reviewing a plan with `review_plan`. Exits plan_mode and begins execution. " +
    "If a previous plan exists, it will be automatically marked as failed (.failed.md).",
  condition(ctx) {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    return findPendingPlans(homeDir).length > 0;
  },
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Plan name to execute. Omit to use the only pending plan.",
      },
    },
    required: [],
  },
  formatDisplay(args) {
    return args.name ? `execute_plan name=${String(args.name)}` : "execute_plan";
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    const pending = findPendingPlans(homeDir);

    if (pending.length === 0) return "Error: no pending plan found. Use `create_plan` first.";

    const requestedName = args.name ? String(args.name).trim() : undefined;
    let target = pending[0];

    if (requestedName) {
      const match = pending.find((p) => p.name === requestedName);
      if (!match) {
        const names = pending.map((p) => p.name).join(", ");
        return `Error: no pending plan named '${requestedName}'. Available: ${names}`;
      }
      target = match;
    } else if (pending.length > 1) {
      const names = pending.map((p) => p.name).join(", ");
      return `Error: multiple pending plans found (${names}). Specify which one with the 'name' parameter.`;
    }

    // Mark previous ACTIVE plan as failed (superseded), not all pending plans
    const ACTIVE_KEY = "ACTIVE_PLAN_NAME";
    const prevActiveName = ctx.teamBoard.get(ctx.agentId, ACTIVE_KEY) as string | undefined;
    const failed: string[] = [];
    if (prevActiveName && prevActiveName !== target.name) {
      // Only mark the previous active plan as failed if it still exists as .plan.md
      const stillPending = pending.find((p) => p.name === prevActiveName);
      if (stillPending) {
        try {
          await renamePlanStatus(homeDir, stillPending.name, "plan", "failed");
          failed.push(stillPending.name);
        } catch { /* file might have been manually moved */ }
      }
    }

    // Track the new active plan
    ctx.teamBoard.set(ctx.agentId, ACTIVE_KEY, target.name, { persist: true });

    // Exit plan_mode
    ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEYS.STATUS, "", { persist: true });
    ctx.teamBoard.remove(ctx.agentId, WORKSPACE_BOARD_KEY);

    // Sync todos via agent_command → todo_write (goes through the real tool pipeline)
    const existingTodos = ctx.teamBoard.get(ctx.agentId, TODO_BOARD_KEY) as TodoItem[] | undefined;
    let todos = existingTodos ?? [];

    if (!todos.length) {
      // Fallback: parse from plan file (orphaned plan without prior create_plan)
      const content = readPlanFileSync(target);
      if (content) todos = parseTodosFromMarkdown(content);
    }

    if (todos.length > 0) {
      ctx.eventBus.emit({
        source: "tool:execute_plan",
        type: "agent_command",
        payload: {
          toolName: "todo_write",
          args: {
            merge: false,
            todos: todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
          },
          agentId: ctx.agentId,
          interrupt: false,
        },
        ts: Date.now(),
      });
    }

    let msg = `Executing plan '${target.name}': exited plan_mode.`;
    if (todos.length > 0) {
      const pendingCount = todos.filter((t) => t.status === "pending").length;
      msg += ` ${todos.length} task(s) dispatched to todo_write (${pendingCount} pending).`;
    }
    if (failed.length > 0) {
      msg += ` Previous active plan superseded: ${failed.join(", ")}.`;
    }
    return msg;
  },
} satisfies ToolDefinition;
