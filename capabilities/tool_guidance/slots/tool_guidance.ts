import type { SlotFactory, ContextSlot, SlotContext } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";

type ToolMeta = {
  guidance?: string;
};

const GENERAL_GUIDELINES = [
  "Fire independent tool calls in parallel in a single batch.",
  "If tool calls depend on each other (e.g. read → edit same file, or output of one is input of another), do NOT call them in parallel — split into separate turns.",
  "Code change flow: grep/glob to locate → read_file for context → edit_file/multi_edit to modify.",
  "On tool errors, diagnose from the output before asking the user.",
].join(" ");

const create: SlotFactory = (ctx: SlotContext): ContextSlot => {
  return {
    name: "tool_guidance",
    priority: SlotPriority.DYNAMIC_TOOL_GUIDANCE,
    cacheHint: "dynamic",
    content: () => {
      const toolDefs = (ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.ACTIVE_TOOLS) ?? []) as ToolMeta[];
      if (toolDefs.length === 0) return "";

      const guidanceLines = toolDefs
        .filter((t) => t.guidance)
        .map((t) => t.guidance as string);

      if (guidanceLines.length === 0) return GENERAL_GUIDELINES;

      return [GENERAL_GUIDELINES, ...guidanceLines].join("\n");
    },
    version: 0,
  };
};

export default create;
