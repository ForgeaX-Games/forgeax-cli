// @desc Command module: agents — list_agents (query) + free_agent (execute)

import type { CommandModule } from "../src/capability/command/types.js";

const agents: CommandModule = {
  async list() {
    return [
      { name: "list_agents", description: "列出当前 instance 所有 agent（节点树视角）",     hasQuery: true,  hasExecute: false },
      { name: "free_agent",  description: "永久删除指定 agent（args[0]=agentId，不可恢复）", hasQuery: false, hasExecute: true },
    ];
  },

  async query(name, _args, ctx) {
    if (name === "list_agents") return ctx.scheduler.getAgentTree().allNodes();
    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name === "free_agent") {
      const agentId = (args[0] ?? "").trim();
      if (!agentId) throw new Error("free_agent: args[0] (agentId) required");
      await ctx.scheduler.controlAgent("remove", agentId);
      return { freed: agentId };
    }
    throw new Error(`No execute for: ${name}`);
  },
};

export default agents;
