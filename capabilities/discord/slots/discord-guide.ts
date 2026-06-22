// @desc Slot — static Discord usage guide, loaded from docs/discord-guide.md
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory, ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url.split("?")[0]));
const guidePath = join(__dirname, "..", "docs", "discord-guide.md");

const create: SlotFactory = () => {
  const slot: ContextSlot = {
    name: "discord-guide",
    priority: SlotPriority.STATIC_ENVIRONMENT,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(guidePath); }
      catch { return ""; }
    },
  };

  return slot;
};

export default create;
