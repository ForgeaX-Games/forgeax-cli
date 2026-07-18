/** ContextWindow —— 装配最终发给 LLM 的消息历史。
 *
 *  与 agenteam ref 1:1（plan §3.8）；只把构造参数从 `(agentId, sessionManager, teamBoard)`
 *  换成 forgeax 的 `(agentId, ledger, blackboard)`：
 *  - **agentId**：传给 blackboard 读 LAST_USER_INPUT_AT；这里就是 agentPath。
 *  - **ledger**：`EventLedger`（per-agent WAL）—— 取 `readAllEvents` /
 *    `readFromTail`；ContextWindow 不直接持 SessionManager。
 *  - **blackboard**：可选；不给就 idle anchor 永远是 undefined → 视作 idle，
 *    每次都会跑 microCompact。生产路径 ConsciousAgent 必给。
 *
 *  Pipeline（plan §3.8）：
 *    history-pipeline (eventsToMessages)
 *      → tool-normalizer.normalizeHistory (timeline 修复)
 *      → media-normalizer.sanitizeMedia (inline media magic 校验)
 *      → micro-compaction.microCompact (idle-gap 闸门 + 老化压缩)
 *
 *  此外：
 *  - locateBoundaries / applyCompactTruncation —— summary boundary 倒序扫描 + 切片。
 *  - buildSystemSnapshot —— 给 SystemPromptDiff 算用的，1:1 与 ref。 */

import type { LLMMessage } from "../llm/types";
import type { BlackboardAPI } from "../core/types";
import type { StoredEvent } from "../ledger/types";
import { applyRewindMask } from "../checkpoint/rewind-mask";
import { replaySystemSnapshot, type SnapshotEntry } from "./system-snapshot";
import { eventsToMessages } from "./history-pipeline";
import { normalizeHistory } from "./tool-normalizer";
import { sanitizeMedia } from "./media-normalizer";
import {
  microCompact,
  trackUserInput,
  getLastUserInputAt,
  type MicroCompactConfig,
} from "./micro-compaction";
import { normalizeContent } from "../message/modality";

/** 给 ContextWindow / compaction 公用的最小 ledger 接口 —— 屏蔽掉 EventLedger 其它
 *  无关字段；测试时也好 stub。生产由 `EventLedger` 实现（ledger/event-ledger.ts）。 */
export interface LedgerReader {
  readAllEvents(): Promise<StoredEvent[]>;
  readFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]>;
}

// ─── Boundary types ─────────────────────────────────────────────────────────

export type BoundaryHit =
  | { type: "compact"; idx: number; summary: string; keepCount: number }
  | {
      type: "partial";
      idx: number;
      summary: string;
      segmentId: string;
      summarizedRange: { fromTs: number; toTs: number };
    };

/** Scan events backwards collecting boundaries。
 *  - partial_boundary: 收一条，继续向前。
 *  - compact_boundary: 收一条后停（之前内容会被该 summary 替换）。
 *  Returns boundaries in oldest-first order，空则 null。 */
export function locateBoundaries(events: StoredEvent[]): {
  boundaries: BoundaryHit[];
  anchorIdx: number;
  hasCompleteBoundary: boolean;
} | null {
  const hits: BoundaryHit[] = [];
  let anchorIdx = events.length;
  let hasCompleteBoundary = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "partial_boundary") {
      const p = ev.payload ?? {};
      hits.push({
        type: "partial",
        idx: i,
        summary: (p.summary as string) ?? "",
        segmentId: (p.segmentId as string) ?? "",
        summarizedRange: (p.summarizedRange as { fromTs: number; toTs: number })
          ?? { fromTs: 0, toTs: 0 },
      });
      anchorIdx = i;
    } else if (ev.type === "compact_boundary") {
      const p = ev.payload ?? {};
      hits.push({
        type: "compact",
        idx: i,
        summary: (p.summary as string) ?? "",
        keepCount: (p.keepCount as number) ?? 0,
      });
      anchorIdx = i;
      hasCompleteBoundary = true;
      break;
    }
  }

  if (hits.length === 0) return null;
  hits.reverse();
  return { boundaries: hits, anchorIdx, hasCompleteBoundary };
}

/** Tail-first shard loading 终止条件：碰到 compact_boundary 就够了；partial 不算。 */
function hasEnoughContext(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact_boundary") return true;
  }
  return false;
}

/** Slice events to model-visible window：
 *  - compact_boundary 之前全砍（保留 keepCount 条 LLM message 例外）；
 *  - 每个 partial_boundary 在其 summarizedRange 内的 event 砍；
 *  - 所有 boundary summary 升格成 synthetic user message 顶到最前；
 *  - 最后一个 boundary 之后的 event（保护区）原样保留。 */
function applyCompactTruncation(events: StoredEvent[]): StoredEvent[] {
  const loc = locateBoundaries(events);
  if (!loc) return events;

  const { boundaries, hasCompleteBoundary } = loc;
  const summaryEvents: StoredEvent[] = [];
  let dropBeforeIdx = 0;
  const keepSet = new Set<number>();
  const droppedByPartial = new Set<number>();

  for (let bi = 0; bi < boundaries.length; bi++) {
    const b = boundaries[bi];

    summaryEvents.push({
      type: "inbound_message",
      ts: events[b.idx].ts,
      source: "system",
      payload: {
        llmMessage: {
          role: "user" as const,
          content: normalizeContent(
            `[Session Summary — Earlier context was compacted]\n\n${b.summary}\n\n` +
            `Recent messages after this summary are preserved verbatim.\n` +
            `Continue from where you left off. Do NOT re-do work listed under "Completed Work" above. ` +
            `Do NOT ask the user to recap — use sections 7-9 of the summary to understand current state.`,
          ),
          ts: events[b.idx].ts,
        },
      },
    });

    if (b.type === "compact") {
      dropBeforeIdx = b.idx + 1;
      if (b.keepCount > 0) {
        let found = 0;
        for (let i = b.idx - 1; i >= 0; i--) {
          if (events[i].payload?.llmMessage) {
            found++;
            keepSet.add(i);
            if (found >= b.keepCount) break;
          }
        }
      }
    } else {
      const scanStart = bi > 0 ? boundaries[bi - 1].idx + 1 : dropBeforeIdx;
      const isLast = bi === boundaries.length - 1;
      if (isLast) {
        const cutoff = b.summarizedRange.toTs;
        for (let i = scanStart; i < b.idx; i++) {
          if (events[i].ts < cutoff) droppedByPartial.add(i);
        }
      } else {
        for (let i = scanStart; i < b.idx; i++) droppedByPartial.add(i);
      }
    }
  }

  const lastBoundaryIdx = boundaries[boundaries.length - 1].idx;
  const result: StoredEvent[] = [];
  result.push(...summaryEvents);

  if (hasCompleteBoundary && keepSet.size > 0) {
    for (const i of keepSet) result.push(events[i]);
  }

  for (let i = dropBeforeIdx; i < lastBoundaryIdx; i++) {
    if (droppedByPartial.has(i)) continue;
    if (events[i].type === "compact_boundary" || events[i].type === "partial_boundary") continue;
    result.push(events[i]);
  }

  for (let i = lastBoundaryIdx + 1; i < events.length; i++) {
    result.push(events[i]);
  }

  return result;
}

/** ContextWindow —— 解析 model-visible conversation history。 */
export class ContextWindow {
  constructor(
    private readonly agentId: string,
    private readonly ledger: LedgerReader,
    private readonly blackboard?: BlackboardAPI,
  ) {}

  /** 扫 event batch 中的 user_input，写 idle anchor 到 blackboard。 */
  trackEvents(events: ReadonlyArray<{ type: string; ts: number }>): void {
    if (this.blackboard) trackUserInput(events, this.blackboard, this.agentId);
  }

  async buildPrompt(options: MicroCompactConfig = {}): Promise<LLMMessage[]> {
    const windowEvents = await this.readWindowEvents();
    const msgs = eventsToMessages(windowEvents);
    const sanitized = await sanitizeMedia(normalizeHistory(msgs).messages);
    const resolved = this.blackboard
      ? { ...options, lastUserInputAt: options.lastUserInputAt ?? getLastUserInputAt(this.blackboard, this.agentId) }
      : options;
    return microCompact(sanitized, resolved);
  }

  /** 不应用 compact truncation 的原始 events —— partialCompact 用来勘察现有边界。 */
  async getWindowEventsRaw(): Promise<StoredEvent[]> {
    return applyRewindMask(await this.ledger.readFromTail(hasEnoughContext));
  }

  async buildSystemSnapshot(): Promise<Map<string, SnapshotEntry>> {
    const allEvents = await this.ledger.readAllEvents();
    return replaySystemSnapshot(applyRewindMask(allEvents));
  }

  private async readWindowEvents(): Promise<StoredEvent[]> {
    const events = applyRewindMask(await this.ledger.readFromTail(hasEnoughContext));
    return applyCompactTruncation(events);
  }
}
