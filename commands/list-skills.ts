// @desc Command module: skills introspection for Admin UI — list_skills / get_skill_content

import type { CommandModule } from "../src/capability/command/types.js";
import * as Q from "../src/instance/instance-queries.js";

const listSkills: CommandModule = {
  async list() {
    return [
      { name: "list_skills",       description: "skills introspection（多 layer + per-agent，给 Admin UI）",      hasQuery: true, hasExecute: false },
      { name: "get_skill_content", description: "单个 skill 内容（args[0]=name；找不到返 null）",                  hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_skills")       return Q.getSkills(ctx.instanceDir);
    if (name === "get_skill_content") return Q.getSkillContent(ctx.instanceDir, (args[0] ?? "").trim());
    throw new Error(`No query for: ${name}`);
  },
};

export default listSkills;
