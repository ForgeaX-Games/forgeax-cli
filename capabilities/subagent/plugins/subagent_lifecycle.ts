// @desc Subagent self-lifecycle — enforce transient lifetime across worker restarts.

import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import { getInstanceScheduler } from "#src/core/scheduler.js";

const RUNTIME_OWNER_KEY = "subagent_runtime_owner";

/**
 * This plugin runs on the **subagent itself** (not the parent).
 *
 * Subagents are transient. A valid subagent is launched and monitored by a
 * parent inside the current worker process. If a subagent starts with the
 * persistent `subagent_type` marker but without the volatile runtime-owner
 * marker, it crossed a worker boundary (restart / stale directory reattach / old
 * monitor lost). That is abnormal: the in-memory monitor link is gone, so the
 * subagent must report failure to its parent if possible, then remove itself.
 */
export default function create(ctx: AgentContext): PluginSource {
  const self = ctx.agentId;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    name: "subagent_lifecycle",
    condition: (c) => c.teamBoard.get(c.agentId, "subagent_type") !== undefined,

    start() {
      // Delay slightly so tree.create/initCapabilities startup settles. Normal
      // same-worker launches have the volatile runtime-owner marker seeded by
      // subagent.ts before tree.create; restarted stale subagents do not.
      timer = setTimeout(() => {
        timer = null;
        const scheduler = getInstanceScheduler();
        const tree = scheduler?.getAgentTree();
        if (!scheduler || !tree) return;

        const runtimeOwner = ctx.teamBoard.get(self, RUNTIME_OWNER_KEY);
        if (typeof runtimeOwner === "string" && runtimeOwner.length > 0) return;

        const node = tree.getNode(self);
        if (!node) return; // already freed

        const parentId = node.parentId;
        const type = String(ctx.teamBoard.get(self, "subagent_type") ?? "unknown");
        const error = `Subagent ${self} restarted or reattached without an active runtime monitor; ` +
          `treating it as failed and removing it.`;

        if (parentId && tree.getNode(parentId)) {
          ctx.eventBus.emit({
            source: "plugin:subagent_lifecycle",
            type: "subagent_error",
            payload: { error, subagentId: self, type },
            ts: Date.now(),
            to: parentId,
            priority: 0,
            handoff: "turn",
          });
        }

        console.log(`[subagent_lifecycle] ${self} stale subagent detected, removing`);
        void scheduler.controlAgent("remove", self).catch(() => {});
      }, 1500);
    },

    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
