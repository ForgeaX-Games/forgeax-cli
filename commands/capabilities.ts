// @desc Command module: capabilities introspection — fetch_capabilities / fetch_capability_package

import type { CommandModule } from "../src/capability/command/types.js";
import * as Q from "../src/instance/instance-queries.js";

const capabilities: CommandModule = {
  async list() {
    return [
      { name: "fetch_capabilities",       description: "capabilities introspection（含 agent-scoped 包）",     hasQuery: true, hasExecute: false },
      { name: "fetch_capability_package", description: "单 capability 包详情（args[0]=pkg，不存在返 null）",   hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name === "fetch_capabilities")       return Q.getCapabilities(ctx.instanceDir);
    if (name === "fetch_capability_package") return Q.getCapabilityPackage(ctx.instanceDir, (args[0] ?? "").trim());
    throw new Error(`No query for: ${name}`);
  },
};

export default capabilities;
