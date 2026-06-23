import type { AgentContext, CapabilityBase } from "#src/core/types.js";
import { bareName } from "#src/registries/name-lookup.js";

export const SKILL_TEAMBOARD_KEY = "ACTIVE_SKILL";

export interface ActiveSkillValue {
  name: string;
  allowed_tools: string[];
}

function getActiveSkill(ctx: AgentContext): ActiveSkillValue | null {
  const val = ctx.teamBoard.get(ctx.agentId, SKILL_TEAMBOARD_KEY);
  if (!val || typeof val !== "object") return null;
  return val as ActiveSkillValue;
}

/**
 * Match a capability name against an allowed-tools token list.
 * Both sides can be bare ("read_file") or qualified ("workspace_read/read_file");
 * comparison is on the bare segment so the two forms are interchangeable —
 * same policy as registry name resolution (see `name-lookup.ts`).
 */
export function matchesAllowedTools(
  toolName: string,
  allowedTools: string[],
): boolean {
  const target = bareName(toolName);
  return allowedTools.some((token) => bareName(token) === target);
}

/** Condition factory: tool visible only when a specific skill is active. */
export function skillOnly(skillName: string): (ctx: AgentContext) => boolean {
  return (ctx) => getActiveSkill(ctx)?.name === skillName;
}

/**
 * Condition factory: capability visible only when it appears in the active
 * skill's allowed_tools list. If no skill is active or allowed_tools is empty,
 * the capability remains visible (no restriction).
 * Works for tools, slots, and plugins — any CapabilityBase with a name.
 */
export function inAllowedTools(): (ctx: AgentContext, self?: CapabilityBase) => boolean {
  return (ctx, self) => {
    const skill = getActiveSkill(ctx);
    if (!skill || skill.allowed_tools.length === 0) return true;
    if (!self) return true;
    return matchesAllowedTools(self.name, skill.allowed_tools);
  };
}
