/** ledger-recovery —— 启动时扫 EventLedger，识别 inflight turn 并补救一致性。
 *
 *  与 agenteam ref `session/session-recovery.ts` 的差异：
 *  - 本轮只做「sealing 未配对 turnStart」这一半 —— inbound_message 回填依赖
 *    `message/message-ingress.ts::eventToSessionMessage`，等后续接入再补
 *    `recoverInbound`。Plan §3.4 写的是「inflight turn 是否需要补救」，
 *    这一半已经足够保证 ledger 自洽。
 *  - agenteam 用 `agentId` 填 source；forgeax 用 agentPath。
 *  - 派发钩子让 caller 同时 publish 到 eventBus，前端 WS 订阅者会立刻收到补的
 *    turnEnd，卡死的 `isStreaming: true` 自动 clear（reload 重启后第一次 attach
 *    就把这件事做完，不必再让前端做 stale-turn 检测）。
 *
 *  调用时机：Session/Scheduler 把某 agent attach 上来时，构造 ConsciousAgent
 *  之前调一遍 —— 那一刻 ledger 已就绪，eventBus observer (ledger-persistence /
 *  WS hub) 也已挂上，publish 一条 turnEnd 既写 WAL（observer 路径）又广播到
 *  WS 客户端，无需双写。 */

import type { Event } from "../core/types";
import type { StoredEvent } from "./types";
import { tt } from "../lib/turn-trace";

/**
 * 扫一组已 replay 的事件，找最后一个未关闭的 turnStart。
 * 若存在则返回 caller 应派发的 turnEnd 事件；否则返回 null。
 */
export function detectUnsealedTurn(
  agentPath: string,
  events: StoredEvent[],
): Event | null {
  let lastTurnStart: number | null = null;
  let sealed = true;
  for (const ev of events) {
    if (ev.type === "hook:turnStart") {
      const turn = (ev.payload as Record<string, unknown> | undefined)?.turn;
      lastTurnStart = typeof turn === "number" ? turn : 0;
      sealed = false;
    } else if (ev.type === "hook:turnEnd") {
      sealed = true;
    }
  }
  if (sealed || lastTurnStart === null) return null;
  tt("recovery.unsealed-turn", {
    agentPath,
    turn: lastTurnStart,
    eventCount: events.length,
    lastTypes: events.slice(-6).map((e) => e.type).join(","),
  });
  return {
    source: `agent:${agentPath}`,
    type: "hook:turnEnd",
    payload: {
      turn: lastTurnStart,
      aborted: true,
      error: "session recovered — previous turn did not end cleanly",
      synthesized: true,
    },
    ts: Date.now(),
  };
}

/**
 * 便捷封装：扫描 + 派发回 ledger / event-bus。
 *
 * Caller 提供 `dispatchEvent` —— 推荐传 `(ev) => session.eventBus.publish(ev, agentPath)`，
 * 这样：
 *   1. `_bindLedgerPersistence` observer 自动把 turnEnd append 到 ledger（不必再
 *      手动调 ledger.append，避免双写）。
 *   2. WS hub observer 把同一条 turnEnd 推给前端，`isStreaming` 立刻 clear。
 *
 * 如果 caller 只想写 ledger 不广播（比如离线 maintenance），传 `(ev) => ledger.append(ev, agentPath)` 即可。
 */
export async function recoverAgentLedger(
  agentPath: string,
  readEvents: () => Promise<StoredEvent[]>,
  dispatchEvent: (event: Event) => void,
): Promise<{ sealedUnfinishedTurn: boolean }> {
  const events = await readEvents();
  const sealEvt = detectUnsealedTurn(agentPath, events);
  if (sealEvt) {
    dispatchEvent(sealEvt);
    return { sealedUnfinishedTurn: true };
  }
  return { sealedUnfinishedTurn: false };
}
