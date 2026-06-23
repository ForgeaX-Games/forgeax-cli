// @desc Package condition: admin-only (config check moved to per-tool conditions)
import type { AgentContext } from "#src/core/types.js";

export default function condition(ctx: AgentContext): boolean {
  return ctx.tree.roleOf(ctx.agentId) === "admin";
}
