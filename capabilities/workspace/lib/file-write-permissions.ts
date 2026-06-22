import { normalize, sep } from "node:path";
import type { AgentContext } from "#src/core/types.js";

function isUnder(target: string, base: string): boolean {
  const normalizedTarget = normalize(target);
  const normalizedBase = normalize(base);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}

/** Check if path is writable for the current agent. */
export function canWritePath(absPath: string, ctx: AgentContext): boolean {
  const root = normalize(ctx.pathManager.root());
  const teamRoot = normalize(ctx.pathManager.team().root());
  const target = normalize(absPath);
  const evolve = ctx.teamBoard.get(ctx.agentId, "STATUS") === "evolve_mode";

  if (evolve) return true;

  // team/ 下可写，instance root 外可写，instance root 内（src/、capabilities/ 等）不可写
  return isUnder(target, teamRoot) || !isUnder(target, root);
}
