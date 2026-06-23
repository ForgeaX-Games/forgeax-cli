import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

export default {
  name: "move_agent",
  description:
    "Move an agent to a new position in the tree (reparent). " +
    "The agent keeps its children, role, and runtime state. " +
    "Use new_parent_id to place it under another agent, or omit to promote it to root.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "ID of the agent to move",
      },
      new_parent_id: {
        type: "string",
        description: "New parent agent ID (omit or null to promote to root level)",
      },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const tree = ctx.tree;
    const agentId = String(args.agent_id).trim();
    const newParentId = args.new_parent_id != null ? String(args.new_parent_id).trim() : null;

    if (!agentId) return "agent_id is required.";

    try {
      tree.reparent(agentId, newParentId);
    } catch (err: any) {
      return err.message ?? String(err);
    }

    const node = tree.getNode(agentId);
    const parentInfo = node?.parentId ? `under '${node.parentId}'` : "as root";
    return `Agent '${agentId}' moved ${parentInfo}.`;
  },
} satisfies ToolDefinition;
