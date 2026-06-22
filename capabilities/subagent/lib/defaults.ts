import type { SubagentMode, SubagentType } from "./types.js";

export const SUBAGENT_DEFAULTS: Record<SubagentType, { defaultMode: SubagentMode }> = {
  observe: { defaultMode: "foreground" },
  plan:    { defaultMode: "foreground" },
  act:     { defaultMode: "foreground" },
};

export const RECURSION_RULES: Record<SubagentType, SubagentType[]> = {
  observe: [],
  plan: ["observe"],
  act: ["observe"],
};

export function isSubagentType(value: string): value is SubagentType {
  return value === "observe" || value === "plan" || value === "act";
}

export function resolveSubagentMode(type: SubagentType, requested?: string): SubagentMode | null {
  if (!requested) return SUBAGENT_DEFAULTS[type].defaultMode;
  return requested === "foreground" || requested === "background" ? requested : null;
}
