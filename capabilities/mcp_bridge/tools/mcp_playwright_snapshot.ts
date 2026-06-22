// @desc Capture an accessibility tree snapshot of the current page (token-cheap visual probe).
import type { ToolDefinition } from "#src/core/types.js";
import { callMcpTool } from "../lib/mcp-client.js";

export default {
  name: "mcp__playwright__browser_snapshot",
  description:
    "Capture an accessibility tree snapshot of the current page via Playwright MCP. Cheaper than a screenshot — prefer this for verifying that a canvas/HUD/element exists. Use AFTER browser_navigate.",
  input_schema: {
    type: "object" as const,
    properties: {
      depth: { type: "number", description: "Limit tree depth (optional)" },
    },
  },
  async execute(args) {
    try {
      const r = await callMcpTool("playwright", "browser_snapshot", args ?? {});
      return JSON.stringify({ ok: true, result: r });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  },
} satisfies ToolDefinition;
