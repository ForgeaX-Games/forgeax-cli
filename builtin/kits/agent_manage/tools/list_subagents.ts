import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { buildRoster } from "../slots/subagent_roster";

export default {
  name: "list_subagents",
  description:
    "List teammate agents available for delegation. Returns each agent's " +
    "id, displayName, role, description, and whether they are already " +
    "active in this session. Call before delegating if you're unsure who " +
    "exists or which name to pass.",
  guidance:
    "**list_subagents**: Use *before* delegate_to_subagent when the user " +
    "asks to involve another agent and you're not sure of the exact id. " +
    "Don't grep the filesystem — call this instead.",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute(_args, ctx): Promise<ToolOutput> {
    const rows = buildRoster(ctx);
    if (rows.length === 0) {
      return "(no teammates registered in this workspace)";
    }
    const lines: string[] = [];
    for (const r of rows) {
      const flag = r.active ? "active" : "spawn-on-demand";
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`- ${r.id} (${r.displayName}, ${r.role}, ${flag})${desc}`);
    }
    return lines.join("\n");
  },
  compactResult() {
    return "[list_subagents]";
  },
  formatDisplay(_args, result) {
    const text = typeof result === "string" ? result : "";
    const count = text.split("\n").filter((l) => l.startsWith("- ")).length;
    return `roster — ${count} teammate${count === 1 ? "" : "s"}`;
  },
  serial: false,
} satisfies ToolDefinition;
