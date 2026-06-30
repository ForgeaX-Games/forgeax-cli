/** event-store —— ledger JSONL 解析器 + sentinel 反向复活的薄包装。
 *
 *  与 agenteam ref 1:1 对齐；只把 sessionDir 参数语义换成 blobsDir：
 *  - blobsDir 给定 → walkAndReinflate 复活每个 event payload 的 sentinel。
 *    框架内部消费者（context-window replay / provider prepare / compaction）走这条。
 *  - blobsDir 不给 → sentinel 原样保留。
 *    外部展示侧（renderer / fetch_session_events 命令）走这条，避免大块 base64 进
 *    内存。要看具体内容用 `fetch_blob(sha256)` 单独捞。 */

import type { StoredEvent } from "./types";
import { walkAndReinflate, LedgerBlobMissingError } from "./event-blob";

export type { StoredEvent };

export { LedgerBlobMissingError };

export function parseEvents(raw: string, blobsDir?: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as StoredEvent); } catch { /* skip malformed */ }
  }
  if (blobsDir) {
    for (const ev of events) {
      if (ev.payload && typeof ev.payload === "object") {
        walkAndReinflate(ev.payload, blobsDir);
      }
    }
  }
  return events;
}
