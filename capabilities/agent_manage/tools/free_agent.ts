import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { getInstanceScheduler } from "#src/core/scheduler.js";

export default {
  name: "free_agent",
  description:
    "[DESTRUCTIVE] Permanently stop the agent, wipe all runtime state, and DELETE its directory. " +
    "Children are promoted to root level. " +
    "Only use when the agent is no longer needed at all. " +
    "If you just edited an agent's files, hot-reload triggers automatically — do NOT free.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "ID of the agent to permanently remove",
      },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const scheduler = getInstanceScheduler();
    if (!scheduler) return "Scheduler not running.";

    const agentId = String(args.agent_id).trim();
    if (!agentId) return "agent_id is required.";
    if (agentId === ctx.agentId) return "Cannot free self.";
    if (!ctx.tree.has(agentId)) return `Agent '${agentId}' not found in tree.`;

    const node = ctx.tree.getNode(agentId)!;
    const childInfo = node.childIds.length > 0
      ? ` Children promoted to root: [${node.childIds.join(", ")}].`
      : "";

    await scheduler.controlAgent("remove", agentId);

    return `Agent '${agentId}' freed (config + home deleted).${childInfo}`;
  },
} satisfies ToolDefinition;
