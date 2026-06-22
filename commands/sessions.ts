// @desc Command module: sessions — list_sessions / fetch_session_events / fetch_session_events_jsonl

import type { CommandModule } from "../src/capability/command/types.js";
import type { StoredEvent } from "../src/context-window/system-snapshot.js";
import * as Q from "../src/instance/instance-queries.js";

function hasCompactBoundary(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "compact_boundary") return true;
  return false;
}

function serializeJsonl(events: StoredEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

const sessions: CommandModule = {
  async list() {
    return [
      { name: "list_sessions",              description: "agent 的 session 列表（args[0]=agentId）",                                  hasQuery: true, hasExecute: false },
      { name: "fetch_session_events",       description: "当前 session 事件流 raw JSONL，tail since compact（args[0]=agentId）",      hasQuery: true, hasExecute: false },
      { name: "fetch_session_events_jsonl", description: "session 全部历史事件 StoredEvent[]（args[0]=agentId）",                  hasQuery: true, hasExecute: false },
    ];
  },

  async query(name, args, ctx) {
    const agentId = (args[0] ?? "").trim();
    if (!agentId) {
      if (name === "list_sessions")              return { sessions: [] };
      if (name === "fetch_session_events")       return "";
      if (name === "fetch_session_events_jsonl") return [];
      throw new Error(`No query for: ${name}`);
    }

    if (name === "list_sessions") {
      const agent = ctx.scheduler.getAgent(agentId);
      return { sessions: agent?.ledger.listShards() ?? [] };
    }

    if (name === "fetch_session_events") {
      const sm = ctx.scheduler.getAgent(agentId)?.ledger;
      if (sm) return serializeJsonl(await sm.readEventsFromTail(hasCompactBoundary));
      const { EventLedger } = await import("../src/session/event-ledger.js");
      const ledger = new EventLedger(agentId);
      if (!ledger.activeShardId) return "";
      return serializeJsonl(await ledger.readFromTail(hasCompactBoundary));
    }

    if (name === "fetch_session_events_jsonl") {
      return Q.readEventsJsonl(ctx.instanceDir, agentId);
    }

    throw new Error(`No query for: ${name}`);
  },
};

export default sessions;
