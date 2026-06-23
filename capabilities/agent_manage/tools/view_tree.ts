import type { ToolDefinition, ToolOutput, AgentTreeNode } from "#src/core/types.js";

function renderNode(node: AgentTreeNode, prefix: string, isLast: boolean, isRoot: boolean): string[] {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const { id, role, childIds, groups } = node.node;
  const childCount = childIds.length > 0 ? ` (${childIds.length} children)` : "";
  const groupStr = groups.length > 0 ? ` groups=[${groups.join(",")}]` : "";
  const lines = [`${prefix}${connector}${id} [${role}]${groupStr}${childCount}`];

  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    lines.push(...renderNode(node.children[i], childPrefix, i === node.children.length - 1, false));
  }
  return lines;
}

export default {
  name: "view_tree",
  description:
    "Display the agent tree showing hierarchy, roles, and parent-child relationships. " +
    "Defaults to showing the subtree rooted at yourself. " +
    "Use root_id to view a different subtree, or omit to see the full tree from all roots.",
  input_schema: {
    type: "object",
    properties: {
      root_id: {
        type: "string",
        description: "Root agent ID for the subtree view (defaults to self; use '*' to show all roots)",
      },
      depth: {
        type: "number",
        description: "Max depth to expand (omit for unlimited)",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const rawRoot = args.root_id != null ? String(args.root_id).trim() : undefined;
    const depth = args.depth != null ? Number(args.depth) : undefined;
    const showAll = rawRoot === "*";
    const rootId = showAll ? undefined : (rawRoot || ctx.agentId);

    if (rootId) {
      const subtree = ctx.tree.view(rootId, depth);
      if (!subtree) return `Agent '${rootId}' not found in tree.`;
      return renderNode(subtree, "", true, true).join("\n");
    }

    const roots = ctx.tree.roots();
    if (roots.length === 0) return "Agent tree is empty.";

    const lines: string[] = [];
    for (const root of roots) {
      const subtree = ctx.tree.view(root.id, depth);
      if (subtree) lines.push(...renderNode(subtree, "", true, true));
    }
    return lines.join("\n");
  },
  serial: false,
} satisfies ToolDefinition;
