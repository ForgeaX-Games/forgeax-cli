// @desc Command module: agent-config — fetch_agent_json / read_agent_overrides (query) + write_agent_overrides (execute)

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { CommandModule } from "../src/capability/command/types.js";
import { deepMerge } from "../src/core/deep-merge.js";

function overridesPath(instanceDir: string, agentId: string): string {
  return join(instanceDir, "team", "homes", agentId, "agent-overrides.json");
}

const agentConfig: CommandModule = {
  async list() {
    return [
      { name: "fetch_agent_json",      description: "agent.json 配置（args[0]=agentId）",                                       hasQuery: true,  hasExecute: false },
      { name: "read_agent_overrides",  description: "agent-overrides.json（args[0]=agentId，不存在返 {}）",                hasQuery: true,  hasExecute: false },
      { name: "write_agent_overrides", description: "深度合并 patch 到 overrides（args[0]=agentId, args[1]=JSON.stringify(patch)）", hasQuery: false, hasExecute: true  },
    ];
  },

  async query(name, args, ctx) {
    const agentId = (args[0] ?? "").trim();
    if (!agentId) {
      if (name === "fetch_agent_json")     return null;
      if (name === "read_agent_overrides") return {};
      throw new Error(`${name}: args[0] (agentId) required`);
    }

    if (name === "fetch_agent_json") {
      const raw = (ctx.scheduler.getAgent(agentId) as unknown as { agentJson?: unknown })?.agentJson;
      return raw ? JSON.parse(JSON.stringify(raw)) : null;
    }

    if (name === "read_agent_overrides") {
      const p = overridesPath(ctx.instanceDir, agentId);
      if (!existsSync(p)) return {};
      try { return JSON.parse(await readFile(p, "utf-8")); } catch { return {}; }
    }

    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name !== "write_agent_overrides") throw new Error(`No execute for: ${name}`);
    const agentId = (args[0] ?? "").trim();
    if (!agentId) throw new Error("write_agent_overrides: args[0] (agentId) required");
    // args[1] is JSON-serialized patch. Command modules own parsing AND validation
    // of their typed input — runner's try/catch only catches throws, but deepMerge
    // silently corrupts overrides.json when fed an array (Object.keys treats it as
    // a plain object), so reject non-plain-object patches before merging.
    let patch: Record<string, unknown> = {};
    if (args[1]) {
      try { patch = JSON.parse(args[1]); }
      catch (err) { throw new Error(`write_agent_overrides: args[1] must be JSON-serialized patch (${(err as Error).message})`); }
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new Error("write_agent_overrides: parsed patch must be a plain object");
      }
    }
    const p = overridesPath(ctx.instanceDir, agentId);
    let existing: Record<string, unknown> = {};
    if (existsSync(p)) {
      try { existing = JSON.parse(await readFile(p, "utf-8")); } catch { /* ignore */ }
    }
    const merged = deepMerge(existing, patch);
    mkdirSync(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    return { ok: true, agentId, overrides: merged };
  },
};

export default agentConfig;
