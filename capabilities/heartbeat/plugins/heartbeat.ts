/** @desc Heartbeat plugin — teamboard-tracked timer as PluginSource */

import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";

const TEAMBOARD_KEY = "lastHeartbeatTime";
const POLL_INTERVAL_MS = 10_000;

export default function create(ctx: AgentContext): PluginSource {
  const config = ctx.getAgentJson().capabilities?.config?.heartbeat as Record<string, unknown> | undefined;
  const intervalMs = (config?.intervalMs as number | undefined) ?? 1_800_000;
  const prompt = (config?.prompt as string | undefined) ?? "";
  const agentId = ctx.agentId;
  const board = ctx.teamBoard;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;

    const last = board.get(agentId, TEAMBOARD_KEY) as number | undefined;
    const now = Date.now();
    const elapsed = last !== undefined ? now - last : Infinity;

    if (elapsed >= intervalMs) {
      board.set(agentId, TEAMBOARD_KEY, now);
      ctx.eventBus.emitToSelf({
        source: "plugin:heartbeat",
        type: "tick",
        payload: { content: prompt },
        ts: now,
        priority: 2,
        handoff: "passive",
      });
      timer = setTimeout(scheduleNext, intervalMs);
    } else {
      const remaining = intervalMs - elapsed;
      timer = setTimeout(scheduleNext, Math.min(remaining, POLL_INTERVAL_MS));
    }
  }

  return {
    name: "heartbeat",

    start() {
      stopped = false;
      scheduleNext();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
