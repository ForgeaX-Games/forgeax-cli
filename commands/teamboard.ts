// @desc Command module: teamboard — fetch_teamboard (args[0]=agentId? optional)

import type { CommandModule } from "../src/capability/command/types.js";

const teamboard: CommandModule = {
  async list() {
    return [
      { name: "fetch_teamboard", description: "TeamBoard 变量（args[0]=agentId？；省略返回所有 agent）",                hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name !== "fetch_teamboard") throw new Error(`No query for: ${name}`);
    const tb = ctx.scheduler.getTeamBoard();
    const aid = (args[0] ?? "").trim() || undefined;
    if (aid) return { [aid]: tb.getAll(aid) };
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of tb.agentIds()) result[id] = tb.getAll(id);
    return result;
  },
};

export default teamboard;
