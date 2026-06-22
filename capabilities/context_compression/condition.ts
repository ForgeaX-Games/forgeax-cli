// @desc Package condition + config defaults for context compression
import type { AgentContext } from "#src/core/types.js";

export default function condition(_ctx: AgentContext): boolean {
  return true; // available to all agents
}

export const configDefaults = {
  threshold: 0.85,
};
