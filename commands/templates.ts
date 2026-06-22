// @desc Command module: templates introspection — fetch_templates / fetch_template_detail

import type { CommandModule } from "../src/capability/command/types.js";
import * as Q from "../src/instance/instance-queries.js";

const templates: CommandModule = {
  async list() {
    return [
      { name: "fetch_templates",       description: "templates introspection",                       hasQuery: true, hasExecute: false },
      { name: "fetch_template_detail", description: "template 详情（args[0]=layer, args[1]=name）",   hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name === "fetch_templates")       return Q.getTemplates(ctx.instanceDir);
    if (name === "fetch_template_detail") return Q.getTemplateDetail(ctx.instanceDir, (args[0] ?? "").trim(), (args[1] ?? "").trim());
    throw new Error(`No query for: ${name}`);
  },
};

export default templates;
