// @desc Package condition + config defaults for heartbeat
import type { AgentContext } from "#src/core/types.js";

export default function condition(_ctx: AgentContext): boolean {
  return true; // availability controlled by enable/disable, not condition
}

export const configDefaults = {
  intervalMs: 1_800_000,
  prompt: "",
};
