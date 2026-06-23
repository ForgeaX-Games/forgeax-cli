// @desc Capture a PNG screenshot of the current page via @playwright/mcp.
import type { ToolDefinition } from "#src/core/types.js";
import { callMcpTool } from "../lib/mcp-client.js";

export default {
  name: "mcp__playwright__browser_take_screenshot",
  description:
    "Take a PNG screenshot of the current page (or an element) via Playwright MCP. Saves to <workspace>/.forgeax/screenshots/<filename>. Use AFTER browser_navigate.",
  input_schema: {
    type: "object" as const,
    properties: {
      filename: { type: "string", description: "Output filename (default: page-<timestamp>.png)" },
      fullPage: { type: "boolean", description: "Capture full scrollable page (default false)" },
      type: { type: "string", enum: ["png", "jpeg"], description: "Image format (default png)" },
    },
  },
  async execute(args) {
    try {
      const r = await callMcpTool("playwright", "browser_take_screenshot", args ?? {});
      return JSON.stringify({ ok: true, result: r });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  },
} satisfies ToolDefinition;
