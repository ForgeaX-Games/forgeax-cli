// @desc Agent-status slot — dynamic per-turn context: time, directory, and operational status
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => ({
  name: "agent-status",
  priority: SlotPriority.DYNAMIC_CONTEXT,
  cacheHint: "dynamic",
  content: () => {
    const status = ctx.teamBoard.get(ctx.agentId, "STATUS") as string | undefined;
    const lines = [
      `Current Time: \${CURRENT_TIME}`,
      `Working Directory: \${CURRENT_DIR}`,
    ];
    if (status) {
      lines.push(`Status: ${status}`);
    }
    return lines.join("\n");
  },
  version: 0,
});

export default create;
