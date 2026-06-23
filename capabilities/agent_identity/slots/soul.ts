// @desc Soul slot — reads agents/{id}/SOUL.md as the agent's identity and persona
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => {
  const soulPath = ctx.pathManager.agent(ctx.agentId).soul();

  return {
    name: "soul",
    priority: SlotPriority.STATIC_CORE,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(soulPath); }
      catch { return ""; }
    },
  };
};

export default create;
