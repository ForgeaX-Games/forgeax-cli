// @desc Package condition + config defaults for memory
import type { AgentContext } from "#src/core/types.js";

export default function condition(_ctx: AgentContext): boolean {
  return true;
}

export const configDefaults = {
  toolCallThreshold: 8,
  enabled: true,
};
