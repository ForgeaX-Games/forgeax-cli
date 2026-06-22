// @desc Sync team contents back to the pack (team → pack write-back)
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { gatewayApi, getInstanceId, formatApiResult } from "../lib/gateway-client.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";

export default {
  name: "sync_pack",
  description:
    "Sync the team's contents back to the pack (team → pack). Auto-detects current instance id. " +
    "Two-step flow: " +
    "(1) call with `preview: true` (default) to see what will be written; " +
    "(2) call with `bump: \"patch\"|\"minor\"|\"major\"` (or explicit `version: \"x.y.z\"`) to execute the write. " +
    "Write range is controlled by `team/.include-pack` (gitignore syntax). " +
    "Default: agents/ skills/ capabilities/ startup-scripts/ — homes/ shared-workspace/ sessions/ logs/ never sync back.",
  guidance:
    "**sync_pack**: ALWAYS preview first (default). The diff list shows what gets written to the pack. " +
    "Execute step requires explicit `bump` (patch/minor/major) or `version` — irreversible write to packs/. " +
    "Common pairing: after `fork_pack` to a freshly forked pack, run `sync_pack` to push team's local diffs into it.",
  input_schema: {
    type: "object",
    properties: {
      preview: {
        type: "boolean",
        description: "If true (default), show what would be synced without writing. Set false plus bump/version to execute.",
      },
      bump: {
        type: "string",
        enum: ["patch", "minor", "major"],
        description: "Semver bump for the new pack version. Mutually exclusive with `version`.",
      },
      version: {
        type: "string",
        description: "Explicit new pack version (e.g. '1.2.3'). Mutually exclusive with `bump`.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolOutput> {
    const instId = getInstanceId(ctx);
    const preview = args.preview !== false && args.bump == null && args.version == null;

    if (preview) {
      const result = await gatewayApi("POST", `/api/instances/${encodeURIComponent(instId)}/team/sync-preview`);
      return formatApiResult(`Sync preview for instance "${instId}"`, result);
    }

    // Resolve newVersion: explicit version takes priority, otherwise bump-based
    let newVersion = typeof args.version === "string" ? args.version : undefined;
    if (!newVersion) {
      const bump = typeof args.bump === "string" ? args.bump : "patch";
      // Read current version from manifest.json and bump
      const teamRoot = ctx.pathManager.team().root();
      try {
        const m = JSON.parse(getSandboxFs().readTextSync(join(teamRoot, "manifest.json")));
        const cur = String(m.version ?? "0.0.0").split(".").map((s) => parseInt(s, 10));
        const [maj = 0, min = 0, pat = 0] = cur;
        if (bump === "major") newVersion = `${maj + 1}.0.0`;
        else if (bump === "minor") newVersion = `${maj}.${min + 1}.0`;
        else newVersion = `${maj}.${min}.${pat + 1}`;
      } catch (err: any) {
        return `Failed to compute new version: ${err?.message ?? err}`;
      }
    }

    const result = await gatewayApi(
      "POST",
      `/api/instances/${encodeURIComponent(instId)}/team/sync`,
      { newVersion },
    );
    return formatApiResult(`Sync execute (version=${newVersion}) for instance "${instId}"`, result);
  },
} satisfies ToolDefinition;
