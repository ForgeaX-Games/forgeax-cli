// @desc Command module: compact — dispatch compact as agent_command with optional `instructions`

import type { CommandModule } from "../src/capability/command/types.js";
import { ConsciousAgent } from "../src/core/conscious-agent.js";

const compact: CommandModule = {
  async list(ctx) {
    if (!ctx.requestingAgentId) return [];
    return [
      { name: "compact", description: "压缩当前对话上下文（args 自由文本作为 instructions 摘要重点）", hasQuery: false, hasExecute: true },
    ];
  },

  async execute(name, args, ctx) {
    if (name !== "compact") throw new Error(`Unknown: ${name}`);
    if (!ctx.requestingAgentId) throw new Error("requestingAgentId required");
    const agent = ctx.scheduler.getAgent(ctx.requestingAgentId);
    if (!(agent instanceof ConsciousAgent)) {
      throw new Error(`Agent "${ctx.requestingAgentId}" is not a ConsciousAgent; cannot compact`);
    }
    // compact is "lax" — all positional args are joined back as free-form
    // instructions text. `/compact 重点保留 X` → args=["重点保留","X"] → "重点保留 X".
    const instructions = args.join(" ").trim();
    ctx.scheduler.eventBus.publish({
      source: "command:compact",
      type: "agent_command",
      payload: {
        toolName: "compact",
        args: instructions ? { instructions } : {},
        agentId: ctx.requestingAgentId,
      },
      ts: Date.now(),
    });
    return { dispatched: true, tool: "compact", instructions: instructions || null };
  },
};

export default compact;
