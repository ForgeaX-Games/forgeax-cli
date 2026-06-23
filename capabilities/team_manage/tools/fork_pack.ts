// @desc Fork manifest pack tracking — switch instance to track a different pack at runtime
import { gatewayApi, getInstanceId, getCurrentPackId, formatApiResult } from "../lib/gateway-client.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";

export default {
  name: "fork_pack",
  description:
    "Switch the instance's manifest.json to track a different pack id (runtime fork). " +
    "Branches by whether newPackId already exists under packs/: (a) exists — just switch manifest.id (no copy); " +
    "(b) does NOT exist — first fork (copy current pack → newPackId), then switch manifest.id. " +
    "After switch, triggers immediate sync so admin doesn't wait for the 10s pack-update poller. " +
    "Auto-rolls back manifest.id if sync fails (does NOT delete a newly forked pack — admin cleans up manually if needed). " +
    "Note: if team has local diffs from the original pack and you want them written into the new pack, " +
    "run `sync_pack` after this — `fork_pack` only copies the original pack's tracked content.",
  guidance:
    "**fork_pack**: `manifest.id` is the single source of truth for the pack index — " +
    "TeamUpdatePoller / SandboxManager / image tag / sync-back all re-read it on every cycle (no cache). " +
    "Changing it propagates to all downstream indexes within 10s; no restart_instance needed.",
  input_schema: {
    type: "object",
    properties: {
      newPackId: {
        type: "string",
        description: "The pack id to track. Created from the current pack if it doesn't exist yet.",
      },
    },
    required: ["newPackId"],
  },
  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolOutput> {
    const newPackId = String(args.newPackId ?? "").trim();
    if (!newPackId) return "newPackId is required.";

    const instId = getInstanceId(ctx);
    const currentPackId = getCurrentPackId(ctx);

    if (newPackId === currentPackId) {
      return `Already tracking pack "${newPackId}" — no fork needed.`;
    }

    // Step 1: check if newPackId already exists in packs/
    const packsList = await gatewayApi("GET", "/api/packs");
    if (packsList.status >= 400) {
      return formatApiResult("List packs failed", packsList);
    }
    const packs: Array<{ id: string }> = packsList.data?.packs ?? [];
    const newPackExists = packs.some((p) => p.id === newPackId);

    // Step 2 (conditional): if not exists, fork from current pack
    let actionLabel: string;
    if (newPackExists) {
      actionLabel = `existing pack "${newPackId}"`;
    } else {
      if (!currentPackId) {
        return `Cannot fork to "${newPackId}": pack does not exist and current pack id is unknown (no source to fork from).`;
      }
      const forkResult = await gatewayApi("POST", "/api/packs/fork", {
        sourceId: currentPackId,
        newId: newPackId,
      });
      if (forkResult.status >= 400) {
        return formatApiResult(`Pack fork "${currentPackId}" → "${newPackId}" failed`, forkResult);
      }
      actionLabel = `freshly forked from "${currentPackId}"`;
    }

    // Step 3: switch manifest.id
    const switchResult = await gatewayApi(
      "PUT",
      `/api/instances/${encodeURIComponent(instId)}/team/manifest`,
      { id: newPackId },
    );
    if (switchResult.status >= 400) {
      return formatApiResult("Switch manifest failed", switchResult);
    }

    // Step 4: trigger immediate sync — don't wait 10s for TeamUpdatePoller
    const updateResult = await gatewayApi(
      "POST",
      `/api/instances/${encodeURIComponent(instId)}/team/update`,
    );
    if (updateResult.status >= 400) {
      // Rollback manifest.id (don't delete a newly forked pack — admin cleans up manually)
      let rollbackMsg = "";
      if (currentPackId) {
        const rollback = await gatewayApi(
          "PUT",
          `/api/instances/${encodeURIComponent(instId)}/team/manifest`,
          { id: currentPackId },
        );
        rollbackMsg = rollback.status >= 400
          ? ` (ROLLBACK ALSO FAILED: ${rollback.status}, manifest may be inconsistent — fix manually)`
          : ` (manifest reverted to "${currentPackId}")`;
      } else {
        rollbackMsg = " (no previous pack id known, cannot rollback)";
      }
      return (
        `Switched manifest to "${newPackId}" (${actionLabel}) but sync failed${rollbackMsg}.\n` +
        formatApiResult("Update result", updateResult)
      );
    }

    return formatApiResult(
      `Fork OK: instance "${instId}" pack "${currentPackId ?? "(unknown)"}" → "${newPackId}" (${actionLabel}, synced)`,
      updateResult,
    );
  },
} satisfies ToolDefinition;
