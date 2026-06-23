// @desc Memory-recognition slot — loads memory-recognition.md as the cognitive map for the agent's memory system
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url.split("?")[0]));
const mdPath = join(__dirname, "memory-recognition.md");

const create: SlotFactory = () => {
  return {
    name: "memory-recognition",
    priority: SlotPriority.STATIC_MEMORY_RECOGNITION,
    cacheHint: "stable",
    version: 0,
    content: () => {
      try { return getSandboxFs().readTextSync(mdPath); }
      catch { return ""; }
    },
  };
};

export default create;
