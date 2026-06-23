// @desc Command module: inspect_tools — expose agent tool definitions to frontend

import type { CommandModule } from "../../src/commands/types";

const inspectTools: CommandModule = {
  async list() {
    return [
      {
        name: "inspect_tools",
        description:
          "列出指定 agent 当前注册的全部工具定义（name + description + input_schema）",
        hasQuery: true,
        hasExecute: false,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name !== "inspect_tools") throw new Error(`Unknown: ${name}`);

    const sid = ctx.sessionId;
    if (!sid) throw new Error("inspect_tools: sessionId required");

    const session = await ctx.sm.open(sid);

    let agentPath = args[0]?.trim() || ctx.requestingAgentId;
    if (!agentPath) {
      const nodes = session.tree.list();
      const root = nodes.find((n) => n.depth === 1);
      agentPath = root?.path;
    }
    if (!agentPath) throw new Error("inspect_tools: no agent available");

    const agent = session.scheduler.getAgent(agentPath);
    if (!agent) throw new Error(`inspect_tools: agent '${agentPath}' not running`);

    const tools = agent.agentContext.tools.list();

    return {
      agentPath,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        guidance: t.guidance ?? null,
      })),
    };
  },
};

export default inspectTools;
