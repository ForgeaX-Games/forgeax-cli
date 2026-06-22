// @desc Package condition: admin-only, always available for Discord setup
import type { AgentContext } from "#src/core/types.js";

export default function condition(ctx: AgentContext): boolean {
  return ctx.tree.roleOf(ctx.agentId) === "admin";
}
