// @desc Command module: team-info — fetch_team_info / fetch_team_manifest

import type { CommandModule } from "../src/capability/command/types.js";
import * as Q from "../src/instance/instance-queries.js";

const teamInfo: CommandModule = {
  async list() {
    return [
      { name: "fetch_team_info",     description: "team manifest 信息（含 backups 列表）",  hasQuery: true, hasExecute: false },
      { name: "fetch_team_manifest", description: "team manifest 原始 JSON",                hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, _args, ctx) {
    if (name === "fetch_team_info")     return Q.getTeamInfo(ctx.instanceDir);
    if (name === "fetch_team_manifest") return Q.getTeamManifest(ctx.instanceDir);
    throw new Error(`No query for: ${name}`);
  },
};

export default teamInfo;
