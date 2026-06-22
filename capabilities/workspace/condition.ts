// @desc Package condition for workspace — operationLevel controls tool visibility
import type { AgentContext } from "#src/core/types.js";

/**
 * Workspace package is always available — operationLevel controls individual tools.
 */
export default function condition(_ctx: AgentContext): boolean {
  return true;
}

/**
 * Default config: read-write access.
 * Subagent templates can override to "read-only".
 *
 * Levels:
 *   "read-only"   — glob, grep, list_dir, read_file, lsp, workspace_map, shell only
 *   "read-write"  — above + edit_file, multi_edit, write_file (default)
 *
 * Shell availability is controlled by the static agent.json config only,
 * not by dynamic teamboard overrides (so plan_mode read-only doesn't hide shell).
 */
export const configDefaults = {
  operationLevel: "read-write",
};

export const WORKSPACE_BOARD_KEY = "workspace:operationLevel";

/**
 * Resolve operationLevel for write tools: teamboard value takes priority,
 * then agent.json config, then "read-write".
 */
export function getOperationLevel(ctx: AgentContext): string {
  const dynamic = ctx.teamBoard.get(ctx.agentId, WORKSPACE_BOARD_KEY) as string | undefined;
  if (dynamic) return dynamic;
  const fromJson = (ctx.getAgentJson() as any).capabilities?.config?.workspace?.operationLevel;
  return fromJson ?? "read-write";
}
