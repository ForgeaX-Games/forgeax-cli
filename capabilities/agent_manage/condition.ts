// @desc Package condition: non-worker agents only
import type { AgentContext } from "#src/core/types.js";

export default function condition(ctx: AgentContext): boolean {
  return ctx.tree.roleOf(ctx.agentId) !== "worker";
}
