import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { getInstanceScheduler } from "#src/core/scheduler.js";

export default {
  name: "start_agent",
  description: "Start an existing agent that is currently stopped. The agent directory must already exist.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "ID of the agent to start",
      },
    },
    required: ["agent_id"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const scheduler = getInstanceScheduler();
    if (!scheduler) return "Scheduler not running.";

    const agentId = String(args.agent_id).trim();
    if (!agentId) return "agent_id is required.";

    return await scheduler.controlAgent("start", agentId);
  },
} satisfies ToolDefinition;
