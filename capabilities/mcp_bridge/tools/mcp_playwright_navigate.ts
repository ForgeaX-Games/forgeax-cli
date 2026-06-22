// @desc Navigate the headless browser to a URL via @playwright/mcp.
import type { ToolDefinition } from "#src/core/types.js";
import { callMcpTool } from "../lib/mcp-client.js";

export default {
  name: "mcp__playwright__browser_navigate",
  description:
    "Open a URL in the Playwright MCP browser. Use this to load the forgeax engine preview after writing game code, then snapshot/screenshot to verify.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "Absolute URL to navigate to (e.g. http://localhost:15173/packages/engine/?game=gta-2.5d)" },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url ?? "");
    if (!url) return JSON.stringify({ error: "missing url" });
    try {
      const r = await callMcpTool("playwright", "browser_navigate", { url });
      return JSON.stringify({ ok: true, result: r });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  },
} satisfies ToolDefinition;
