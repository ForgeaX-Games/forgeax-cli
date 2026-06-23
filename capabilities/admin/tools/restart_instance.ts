// @desc Request the gateway to restart this instance
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

export default {
  name: "restart_instance",
  description:
    "Request an instance restart. Use after modifying framework source code to apply changes. " +
    "The current conversation will be interrupted; the instance will restart and resume.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Brief explanation of why a restart is needed",
      },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolOutput> {
    const reason = String(args.reason ?? "").trim() || "No reason given";
    if (!process.send) {
      return "Error: restart_instance is only available when running as a Gateway subprocess.";
    }
    process.send({ ch: "ctl", type: "requestRestart" });
    return `Restart requested (reason: ${reason}). The instance will restart shortly.`;
  },
} satisfies ToolDefinition;
