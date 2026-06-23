// @desc Environment slot — dynamically loads docker.md or direct.md based on sandbox status
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { getSandboxManager } from "#src/sandbox/manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url.split("?")[0]));

const create: SlotFactory = () => {
  return {
    name: "environment",
    priority: SlotPriority.STATIC_ENVIRONMENT,
    cacheHint: "stable",
    version: 0,
    content: () => {
      const isDocker = getSandboxManager()?.isEnabled() ?? false;
      const envFile = isDocker ? "docker.md" : "direct.md";
      try { return getSandboxFs().readTextSync(join(__dirname, "environment", envFile)); }
      catch { return ""; }
    },
  };
};

export default create;
