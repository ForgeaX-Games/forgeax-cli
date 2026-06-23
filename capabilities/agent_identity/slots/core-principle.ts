// @desc Core-principle slot — reads agents/{id}/PRINCIPLE.md as behavioral constraints
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => {
  const principlePath = ctx.pathManager.agent(ctx.agentId).principleFile();

  return {
    name: "core-principle",
    priority: SlotPriority.STATIC_PRINCIPLE,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(principlePath); }
      catch { return ""; }
    },
  };
};

export default create;
