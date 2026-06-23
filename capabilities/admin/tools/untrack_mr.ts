// @desc Manually mark a MR as closed in the tracking list
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { getTrackedMRs, closeTrackedMR } from "../lib/active-mrs.js";

export default {
  name: "untrack_mr",
  description:
    "Mark a merge request as closed in the tracking list. " +
    "Use when a MR was abandoned or no longer needs monitoring. " +
    "The MR is preserved in history (visible with check_mr_status include_closed=true).",
  input_schema: {
    type: "object",
    properties: {
      iid: {
        type: "number",
        description: "MR iid to mark as closed (e.g. 53)",
      },
    },
    required: ["iid"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const iid = args.iid as number;
    if (!iid) return "iid is required.";

    const allMRs = getTrackedMRs(ctx, { includeClosed: true });
    const target = allMRs.find((m) => m.iid === iid);

    if (!target) {
      const open = getTrackedMRs(ctx);
      const tracked = open.map((m) => `!${m.iid}`).join(", ");
      return tracked
        ? `MR !${iid} is not being tracked. Currently tracked (open): ${tracked}`
        : `MR !${iid} is not being tracked. No MRs are currently tracked.`;
    }

    if (target.status === "closed") {
      return `MR !${iid} is already closed (reason: ${target.closedReason ?? "unknown"}).`;
    }

    closeTrackedMR(ctx, target.iid, target.projectPath, "manual");

    const remaining = getTrackedMRs(ctx);
    return [
      `✓ MR !${iid} marked as closed.`,
      `  Branch: ${target.branch}`,
      `  URL: ${target.url}`,
      "",
      `Remaining open: ${
        remaining.length > 0
          ? remaining.map((m) => `!${m.iid}`).join(", ")
          : "none"
      }`,
    ].join("\n");
  },
} satisfies ToolDefinition;
