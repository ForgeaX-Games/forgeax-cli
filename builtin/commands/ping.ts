// @desc Ping — minimal end-to-end verifier (mirrors agenteam-os-ref commands/ping.ts)

import type { CommandModule } from "../../src/commands/types";

const ping: CommandModule = {
  async list() {
    return [{ name: "ping", description: "Test the command system (query → { ok, ts })", hasQuery: true, hasExecute: false }];
  },
  async query() {
    return { ok: true, ts: Date.now() };
  },
};

export default ping;
