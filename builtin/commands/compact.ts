// @desc Command module: compact — run compaction directly (no agent turn needed)
//
// 当用户在 web 端输入 `/compact [instructions]` 时，command 直接调用
// compactCurrentSession，在 server 侧完成压缩；不走 agent_command → agent turn
// 流程，避免压缩后还需一次 LLM 响应（那次响应经常卡住或静默返回）。

import type { CommandModule } from "../../src/commands/types";
import { compactCurrentSession } from "../../src/context-window/summary-compaction";

const compact: CommandModule = {
  async list() {
    return [
      {
        name: "compact",
        description: "压缩当前对话上下文（参数为可选的摘要重点提示）",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async execute(name, args, ctx) {
    if (name !== "compact") throw new Error(`Unknown: ${name}`);

    const sid = ctx.sessionId;
    if (!sid) throw new Error("compact: sessionId required");

    const session = await ctx.sm.open(sid);

    // Resolve target agent: prefer requestingAgentId, fall back to root agent ("forge" or first depth-1).
    let agentPath = ctx.requestingAgentId;
    if (!agentPath) {
      const nodes = session.tree.list();
      const forge = nodes.find((n) => n.depth === 1 && n.display === "forge");
      const root = forge ?? nodes.find((n) => n.depth === 1);
      agentPath = root?.path;
    }
    if (!agentPath) throw new Error("compact: no agent available in session");

    const instructions = args.join(" ").trim();

    // Get ledger + resolveModels from the running agent instance.
    const agent = session.scheduler.getAgent(agentPath);
    if (!agent) throw new Error(`compact: agent '${agentPath}' not running`);

    const resolveModels = agent.agentContext.resolveModels;
    if (!resolveModels) throw new Error("compact: resolveModels unavailable on agent");

    const ledger = session.getOrCreateLedger(agentPath);

    const ac = new AbortController();
    const result = await compactCurrentSession({
      agentId: agentPath,
      ledger,
      eventBus: agent.boundEventBus,
      resolveModels,
      signal: ac.signal,
      instructions: instructions || undefined,
    });

    if (result.ok === false) {
      return { compacted: false, reason: result.reason };
    }

    return {
      compacted: true,
      originalMessages: result.originalMessageCount,
      newMessages: result.newMessageCount,
      tokensBefore: result.tokensBefore ?? null,
    };
  },
};

export default compact;
