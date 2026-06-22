// @desc Clean the docker image of the current pack (auto-detects current pack id)
import { gatewayApi, getCurrentPackId, formatApiResult } from "../lib/gateway-client.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";

export default {
  name: "clean_image",
  description:
    "Remove the docker image of the current pack. Auto-detects current pack id from manifest.json. " +
    "Use when the pack's image is stale (e.g. Dockerfile updated but old image is cached). " +
    "After this, the next ensureSandbox cycle will rebuild the image.",
  guidance:
    "**clean_image**: forces image rebuild on next ensureSandbox. Use after Dockerfile changes — " +
    "pack registry won't auto-detect Dockerfile diffs unless image is removed. " +
    "Often paired with `rm_container` (image rebuild requires container recreation).",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: AgentContext): Promise<ToolOutput> {
    const packId = getCurrentPackId(ctx);
    if (!packId) return "Cannot determine current pack id (manifest.json missing or has no id field).";
    const result = await gatewayApi("DELETE", `/api/packs/${encodeURIComponent(packId)}/image`);
    return formatApiResult(`Clean image for pack "${packId}"`, result);
  },
} satisfies ToolDefinition;
