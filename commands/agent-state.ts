// @desc Command module: agent-state — fetch_agent_tree / is_agent_running / get_agent_status / fetch_default_agent

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandModule } from "../src/capability/command/types.js";

const agentState: CommandModule = {
  async list() {
    return [
      { name: "fetch_agent_tree",    description: "agent 树（节点列表，含角色/父子）",                                  hasQuery: true, hasExecute: false },
      { name: "is_agent_running",    description: "agent RUNNING 标志（args[0]=agentId）",                                hasQuery: true, hasExecute: false },
      { name: "get_agent_status",    description: "agent STATUS（plan_mode / evolve_mode 等，args[0]=agentId）",            hasQuery: true, hasExecute: false },
      { name: "fetch_default_agent", description: "manifest.defaultAgent（首次进入兜底用）",                            hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name === "fetch_agent_tree") return ctx.scheduler.getAgentTree().allNodes();

    if (name === "fetch_default_agent") {
      const p = join(ctx.instanceDir, "team", "manifest.json");
      if (!existsSync(p)) return null;
      try {
        const m = JSON.parse(await readFile(p, "utf-8")) as { defaultAgent?: unknown };
        return typeof m.defaultAgent === "string" && m.defaultAgent ? m.defaultAgent : null;
      } catch { return null; }
    }

    const agentId = (args[0] ?? "").trim();
    if (!agentId) {
      if (name === "is_agent_running") return false;
      if (name === "get_agent_status") return "";
      throw new Error(`${name}: args[0] (agentId) required`);
    }

    if (name === "is_agent_running") {
      try { return ctx.scheduler.getTeamBoard().getAll(agentId)?.RUNNING === true; } catch { return false; }
    }
    if (name === "get_agent_status") {
      try { return (ctx.scheduler.getTeamBoard().getAll(agentId)?.STATUS as string) ?? ""; } catch { return ""; }
    }

    throw new Error(`No query for: ${name}`);
  },
};

export default agentState;
