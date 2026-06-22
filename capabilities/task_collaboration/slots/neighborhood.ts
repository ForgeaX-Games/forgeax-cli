import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => ({
  name: "neighborhood",
  priority: SlotPriority.DYNAMIC_CONTEXT,
  cacheHint: "dynamic",
  content: () => {
    const me = ctx.tree.getNode(ctx.agentId);
    if (!me) return "";

    const lines: string[] = [];

    const parent = me.parentId ? ctx.tree.getNode(me.parentId) : null;
    if (parent) {
      lines.push(`上级: ${parent.id} [${parent.role}]`);
    } else {
      lines.push("上级: 无（最高层级）");
    }

    const siblings = me.parentId
      ? ctx.tree.getChildren(me.parentId).filter(n => n.id !== ctx.agentId)
      : ctx.tree.roots().filter(n => n.id !== ctx.agentId);

    if (siblings.length > 0) {
      lines.push(`同事 (${siblings.length}):`);
      for (const s of siblings) {
        lines.push(`  - ${s.id} [${s.role}]`);
      }
    }

    return lines.join("\n");
  },
  version: 0,
});

export default create;
