import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { getSystemPromptComposer } from "../../../../src/orchestration-seams";

export default function environmentSlot(ctx: AgentContext): ContextSlot {
  return {
    name: "environment",
    description:
      "Resolved session paths, game info, installed workbench plugins, " +
      "and available skills. Lets the LLM know where it is working without " +
      "needing to run shell commands.",
    priority: SlotPriority.STATIC_ENVIRONMENT,
    cacheHint: "stable",
    version: 1,
    content: () => getSystemPromptComposer()?.environment({ cwd: ctx.cwd }) ?? "",
  };
}
