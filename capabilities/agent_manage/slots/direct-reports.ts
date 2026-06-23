import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => ({
  name: "direct-reports",
  priority: SlotPriority.DYNAMIC_CONTEXT + 1,
  cacheHint: "dynamic",
  content: () => {
    const children = ctx.tree.getChildren(ctx.agentId);
    if (children.length === 0) return "直属下属: 无";

    const lines: string[] = [`直属下属 (${children.length}):`];
    for (const c of children) {
      const grandchildren = ctx.tree.getChildren(c.id);
      const suffix = grandchildren.length > 0 ? ` (管理 ${grandchildren.length} 人)` : "";
      lines.push(`  - ${c.id} [${c.role}]${suffix}`);
    }

    return lines.join("\n");
  },
  version: 0,
});

export default create;
