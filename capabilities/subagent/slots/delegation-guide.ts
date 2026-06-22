// @desc Delegation guide slot — universal delegation principles + subagent usage guide
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url.split("?")[0]));
const mdPath = join(__dirname, "./delegation-guide.md");

const create: SlotFactory = () => {
  return {
    name: "delegation-guide",
    priority: SlotPriority.STATIC_FRAMEWORK + 4,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(mdPath).trimEnd(); }
      catch { return ""; }
    },
  };
};

export default create;
