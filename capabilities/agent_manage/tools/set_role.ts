import type { ToolDefinition, ToolOutput, AgentRole } from "#src/core/types.js";

const VALID_ROLES = new Set<AgentRole>(["admin", "steward", "worker"]);

export default {
  name: "set_role",
  description:
    "Change an agent's role in the tree. " +
    "Roles: admin (top-level manager), steward (root-level coordinator), worker (child executor).",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "ID of the agent whose role to change",
      },
      role: {
        type: "string",
        enum: ["admin", "steward", "worker"],
        description: "New role to assign",
      },
    },
    required: ["agent_id", "role"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const tree = ctx.tree;
    const agentId = String(args.agent_id).trim();
    const role = String(args.role).trim() as AgentRole;

    if (!agentId) return "agent_id is required.";
    if (!VALID_ROLES.has(role)) return `Invalid role '${role}'. Must be: admin, steward, worker.`;
    if (!tree.has(agentId)) return `Agent '${agentId}' not found in tree.`;

    const oldRole = tree.roleOf(agentId);
    if (oldRole === role) return `Agent '${agentId}' is already [${role}].`;

    tree.updateRole(agentId, role);
    return `Agent '${agentId}' role changed: [${oldRole}] → [${role}].`;
  },
} satisfies ToolDefinition;
