// @desc Remove the team's sandbox containers (auto-detects current team)
import { gatewayApi, getInstanceId, formatApiResult } from "../lib/gateway-client.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";

export default {
  name: "rm_container",
  description:
    "Remove the team's sandbox containers. Auto-detects current instance id — no args needed. " +
    "Use when the container has drifted (e.g. stale image cache) or to force a clean restart. " +
    "After this, the next ensureSandbox cycle will rebuild the container.",
  guidance:
    "**rm_container**: destroys the running container — overlay layer (npm globals, transient files) lost. " +
    "Bind-mounted paths (instance root, mounts.json entries) preserved. Next ensureSandbox cycle rebuilds.",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: AgentContext): Promise<ToolOutput> {
    const instId = getInstanceId(ctx);
    const result = await gatewayApi("DELETE", `/api/instances/${encodeURIComponent(instId)}/team/containers`);
    return formatApiResult(`Remove containers for instance "${instId}"`, result);
  },
} satisfies ToolDefinition;
