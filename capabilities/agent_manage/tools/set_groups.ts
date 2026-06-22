// @desc Set an agent's groups in the agent tree
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

export default {
  name: "set_groups",
  description:
    "Set an agent's groups (replaces entire array). " +
    "Groups are static tags used for task eligibility and agent filtering. " +
    "Pass an empty array to clear all groups.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "ID of the agent whose groups to set",
      },
      groups: {
        type: "array",
        items: { type: "string" },
        description: "List of group names. Empty array clears all groups.",
      },
    },
    required: ["agent_id", "groups"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const tree = ctx.tree;
    const agentId = String(args.agent_id).trim();
    const groups = Array.isArray(args.groups)
      ? (args.groups as unknown[]).map(g => String(g).trim()).filter(g => g)
      : [];

    if (!agentId) return "agent_id is required.";
    if (!tree.has(agentId)) return `Agent '${agentId}' not found in tree.`;

    const oldGroups = tree.getAgentGroups(agentId);
    tree.updateGroups(agentId, groups);

    const oldStr = oldGroups.length > 0 ? `[${oldGroups.join(", ")}]` : "[]";
    const newStr = groups.length > 0 ? `[${groups.join(", ")}]` : "[]";
    return `Agent '${agentId}' groups changed: ${oldStr} → ${newStr}.`;
  },
} satisfies ToolDefinition;
