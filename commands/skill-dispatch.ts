// @desc Command module: dynamic skill execution — `/skill-name` slash → publish `read_skill` agent_command

import type { CommandModule, CallContext } from "../src/capability/command/types.js";
import { ConsciousAgent } from "../src/core/conscious-agent.js";
import { getPathManager } from "../src/fs/path-manager.js";
import { discoverSkills } from "../capabilities/skills/lib/skills-loader.js";
import { TEAMBOARD_KEYS } from "../src/defaults/teamboard-vars.js";

function currentDir(ctx: CallContext): string | undefined {
  if (!ctx.requestingAgentId) return undefined;
  return ctx.scheduler.getTeamBoard().get(ctx.requestingAgentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined;
}

const skillDispatch: CommandModule = {
  async list(ctx) {
    if (!ctx.requestingAgentId) return [];
    const items = discoverSkills(getPathManager(), ctx.requestingAgentId, currentDir(ctx));
    return items.map((s) => {
      // Slash UI is single-line; many skill descriptions span hundreds of chars
      // ("Use when ..." guidance for LLM trigger accuracy). Take the first
      // sentence — split on either CJK 。 or ASCII . followed by whitespace —
      // and fall back to the full string if no sentence boundary is found.
      const first = s.description.split(/(?<=[。.])\s/, 1)[0] ?? s.description;
      return {
        name: s.name,
        description: `[skill] ${first.trim()}`,
        hasQuery: false,
        hasExecute: true,
      };
    });
  },

  async execute(name, _args, ctx) {
    if (!ctx.requestingAgentId) throw new Error("requestingAgentId required");
    const agent = ctx.scheduler.getAgent(ctx.requestingAgentId);
    if (!(agent instanceof ConsciousAgent)) {
      throw new Error(`Agent "${ctx.requestingAgentId}" is not a ConsciousAgent; cannot dispatch agent_command`);
    }
    const exists = discoverSkills(getPathManager(), ctx.requestingAgentId, currentDir(ctx)).some((s) => s.name === name);
    if (!exists) throw new Error(`Skill not found: ${name}`);
    ctx.scheduler.eventBus.publish({
      source: "command:skill-dispatch",
      type: "agent_command",
      payload: { toolName: "read_skill", args: { name }, agentId: ctx.requestingAgentId },
      ts: Date.now(),
    });
    return { dispatched: true, tool: "read_skill", skillId: name };
  },
};

export default skillDispatch;
