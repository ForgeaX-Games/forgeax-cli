import type { ContextSlot, SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx): ContextSlot => {
  const getEntries = (): { id: string; type: string }[] => {
    const ids = (ctx.teamBoard.get(ctx.agentId, "subagents") as string[] | undefined) ?? [];
    return ids.map(id => ({
      id,
      type: (ctx.teamBoard.get(id, "subagent_type") as string) ?? "unknown",
    }));
  };

  return {
    name: "subagents",
    priority: SlotPriority.DYNAMIC_SUBAGENTS,
    cacheHint: "dynamic",
    condition: () => getEntries().length > 0,
    content: () => {
      const items = getEntries();
      const lines = items.map(e => `  - [${e.type}] ${e.id}`);
      return `## Active Subagents (${items.length})\n\n${lines.join("\n")}\n`;
    },
    version: 0,
  };
};

export default create;
