import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import { SKILL_TEAMBOARD_KEY } from "../lib/skill-conditions.js";

export default function create(ctx: AgentContext): PluginSource {
  let unhook: (() => void) | null = null;
  return {
    name: "active_skill_cleaner",

    start() {
      unhook = ctx.eventBus.observe((event, emitterId) => {
        if (emitterId === ctx.agentId && event.type === ctx.hook.TurnEnd) {
          ctx.teamBoard.remove(ctx.agentId, SKILL_TEAMBOARD_KEY);
        }
      });
    },

    stop() {
      unhook?.();
      unhook = null;
    },
  };
}
