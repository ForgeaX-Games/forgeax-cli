// @desc Command module: backups introspection — fetch_backups / fetch_backup_manifest

import type { CommandModule } from "../src/capability/command/types.js";
import * as Q from "../src/instance/instance-queries.js";

const backups: CommandModule = {
  async list() {
    return [
      { name: "fetch_backups",         description: "backups 列表",                            hasQuery: true, hasExecute: false },
      { name: "fetch_backup_manifest", description: "backup manifest（args[0]=name）",            hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    if (name === "fetch_backups")         return Q.getBackups(ctx.instanceDir);
    if (name === "fetch_backup_manifest") return Q.getBackupManifest(ctx.instanceDir, (args[0] ?? "").trim());
    throw new Error(`No query for: ${name}`);
  },
};

export default backups;
