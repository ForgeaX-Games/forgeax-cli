// @desc Package condition: admin-only team/pack operational tools (rm_container / clean_image / sync_pack / fork_pack)
import type { AgentContext } from "#src/core/types.js";

export default function condition(ctx: AgentContext): boolean {
  return ctx.tree.roleOf(ctx.agentId) === "admin";
}
