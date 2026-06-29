/** rewind-mask —— rewind_boundary / rewind_cancel 的可见性语义,纯函数。
 *
 *  设计(checkpoint-回退点设计方案.md 决策 2/5):
 *  - 回退不物理截断 WAL:append `rewind_boundary{boundaryId,targetMsgId,targetTs}`;
 *  - 恢复(Cursor 软回退)= append `rewind_cancel{boundaryId}`,被 cancel 的
 *    boundary 失效,区间重新可见;
 *  - 定格 = boundary 之后出现新的 `user_input`(无独立事件,可从流中推导);
 *  - 被屏蔽区间 = [目标 user_input(payload.msgId === targetMsgId) .. boundary],
 *    含两端;子 agent ledger 没有那条 user_input,fallback 用 targetTs(ts >=
 *    targetTs 的第一条)定起点;
 *  - boundary / cancel 事件本身永不可见(对 LLM 与 UI 都是机制噪声)。
 *
 *  两个消费方:
 *  - server context-window:无条件全量 mask(挂起态也不给 LLM 看被回退内容);
 *  - interface 回放:挂起 boundary 的区间要「置灰可见」,用 keepBoundaryVisible
 *    跳过那一个 boundary 的剔除,由 UI 自己渲染置灰。
 *
 *  interface 侧有同语义的镜像实现(packages/interface/src/lib/event-engine/
 *  rewind-mask.ts),改语义时两边同步。 */

import type { StoredEvent } from "../ledger/types";

export const REWIND_BOUNDARY = "rewind_boundary";
export const REWIND_CANCEL = "rewind_cancel";

export interface RewindBoundaryInfo {
  boundaryId: string;
  targetMsgId: string;
  targetTs: number;
  mode: string;
  /** boundary 事件在输入数组中的下标。 */
  index: number;
  ts: number;
}

function boundaryInfo(ev: StoredEvent, index: number): RewindBoundaryInfo | null {
  const p = ev.payload ?? {};
  const boundaryId = p.boundaryId as string | undefined;
  if (!boundaryId) return null;
  return {
    boundaryId,
    targetMsgId: (p.targetMsgId as string) ?? "",
    targetTs: (p.targetTs as number) ?? ev.ts,
    mode: (p.mode as string) ?? "conversation",
    index,
    ts: ev.ts,
  };
}

function cancelledIds(events: StoredEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.type !== REWIND_CANCEL) continue;
    const id = (ev.payload ?? {}).boundaryId as string | undefined;
    if (id) ids.add(id);
  }
  return ids;
}

/** 被屏蔽区间起点:优先 msgId 精确匹配(root agent 的 ledger 有那条
 *  user_input);找不到(子 agent / shard 截断)退回 targetTs。 */
function rangeStart(events: StoredEvent[], b: RewindBoundaryInfo): number {
  for (let j = b.index - 1; j >= 0; j--) {
    const e = events[j];
    if (e.type === "user_input" && (e.payload ?? {}).msgId === b.targetMsgId) return j;
  }
  for (let j = 0; j < b.index; j++) {
    if (events[j].ts >= b.targetTs) return j;
  }
  return b.index; // 区间整个不在本窗口 —— 只隐藏 boundary 自身
}

/** 应用回退可见性。opts.keepBoundaryVisible:这个 boundaryId 的区间不剔除
 *  (boundary/cancel 事件本身仍剔除)—— UI 挂起态置灰用。 */
export function applyRewindMask(
  events: StoredEvent[],
  opts: { keepBoundaryVisible?: string } = {},
): StoredEvent[] {
  let sawRewind = false;
  for (const ev of events) {
    if (ev.type === REWIND_BOUNDARY || ev.type === REWIND_CANCEL) {
      sawRewind = true;
      break;
    }
  }
  if (!sawRewind) return events; // 热路径零成本

  const cancelled = cancelledIds(events);
  const drop = new Array<boolean>(events.length).fill(false);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === REWIND_CANCEL) {
      drop[i] = true;
      continue;
    }
    if (ev.type !== REWIND_BOUNDARY) continue;
    drop[i] = true;
    const b = boundaryInfo(ev, i);
    if (!b) continue;
    if (cancelled.has(b.boundaryId)) continue;
    if (opts.keepBoundaryVisible === b.boundaryId) continue;
    const start = rangeStart(events, b);
    for (let j = start; j < i; j++) drop[j] = true;
  }
  return events.filter((_, i) => !drop[i]);
}

/** 挂起中的回退 = 最后一条未被 cancel 的 boundary,且其后没有新的 user_input。
 *  返回 null = 无挂起(从未回退 / 已恢复 / 已定格)。 */
export function findPendingRewind(events: StoredEvent[]): RewindBoundaryInfo | null {
  const cancelled = cancelledIds(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "user_input") return null; // 先撞到新消息 → 已定格
    if (ev.type !== REWIND_BOUNDARY) continue;
    const b = boundaryInfo(ev, i);
    if (!b) continue;
    if (cancelled.has(b.boundaryId)) continue;
    return b;
  }
  return null;
}
