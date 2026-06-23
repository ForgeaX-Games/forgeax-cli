// @desc Toggle evolve mode — grants admin write access to the full instance root
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";

export default {
  name: "evolve_mode",
  description:
    "Toggle evolve mode on or off. When enabled, you gain write access to the full instance root " +
    "(src/, capabilities/, docs/, etc.) and the AGENTIC.md framework development guide is loaded into context. " +
    "When disabled, write access is restricted to team/ and paths outside the instance root. " +
    "Evolve mode is persistent — it survives instance restart.\n\n" +
    "Use evolve mode when you need to: modify or create capability packages (tools/slots/plugins), " +
    "update framework documentation (AGENTS.md, AGENTIC.md, docs/), " +
    "refactor framework source code (src/), or create/update agent templates (templates/). " +
    "Do NOT use evolve mode for routine tasks like reading files, running shell commands, " +
    "or working within team/ — those work without evolve mode.",
  input_schema: {
    type: "object",
    properties: {
      enable: {
        type: "boolean",
        description: "true to activate evolve mode, false to deactivate",
      },
    },
    required: ["enable"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const enable = Boolean(args.enable);
    ctx.teamBoard.set(ctx.agentId, "STATUS", enable ? "evolve_mode" : "", { persist: true });

    if (!enable) {
      return "Evolve mode deactivated. Write access restricted to team/ and external paths.";
    }

    // Read evolve-checklist.md and embed directly — agents ignore "go read X" guidance once focused
    const checklistPath = join(ctx.pathManager.root(), "capabilities/admin/slots/evolve-checklist.md");
    let checklist: string;
    try {
      checklist = getSandboxFs().readTextSync(checklistPath);
    } catch {
      checklist = "(evolve-checklist.md not found — use `ref(doc=evolve_checklist)` as fallback)";
    }

    return [
      "Evolve mode activated. You now have write access to the full instance root (src/, capabilities/, docs/, etc.).",
      "",
      "## Evolve Workflow Guide",
      "",
      checklist,
    ].join("\n");
  },
} satisfies ToolDefinition;
