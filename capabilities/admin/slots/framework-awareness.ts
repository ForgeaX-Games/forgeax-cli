// @desc Framework awareness slot — injects AGENTIC.md for admin role (always-on)
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const create: SlotFactory = (ctx) => {
  const agenticPath = join(ctx.pathManager.root(), "AGENTIC.md");

  return {
    name: "framework-awareness",
    // Promoted to stable: AGENTIC.md is conversation-stable framework doc,
    // edited at most a few times per week. Living in the stable section means
    // the ~3500-token AGENTIC.md content rides the cache_read prefix every
    // turn instead of being re-billed as naked input. The rare doc-update
    // cache-bust (one bust per edit) is dominated by the per-turn savings.
    priority: SlotPriority.STATIC_FRAMEWORK,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(agenticPath); }
      catch { return ""; }
    },
  };
};

export default create;
