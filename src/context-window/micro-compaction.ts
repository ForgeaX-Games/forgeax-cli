/** micro-compaction —— idle-gap 闸门 + tool / media 老化压缩。
 *
 *  与 agenteam ref 1:1（plan §3.8）：
 *  - **闸门**：只有当 `now - lastUserInputAt >= idleGapMs`（默认 20min）才跑；
 *    否则历史 byte-identical 返回，让 provider 的 prefix cache 跨 turn 命中。
 *  - **保护区**：最近 N 条 tool_result + 最近 M 条带重型 media 的消息保留原样
 *    （N=20 / M=2，由 agent.json::historyKeep 配）。
 *  - **压缩规则**：
 *    - tool_result 在保护区外 → 找 ToolDefinition.compactResult；有就调，没有就
 *      默认占位 "[Old tool result content cleared]"。
 *    - 重型 media（image / audio / video / file / text_file）在保护区外 → 转 text
 *      占位（含 path 或 "[image removed]"）。
 *  - **idle anchor**：trackUserInput / getLastUserInputAt —— per-agent 写读
 *    blackboard 的 LAST_USER_INPUT_AT key。 */

import {
  isMediaContentPart,
  isInlineMediaContentPart,
  isFileMediaContentPart,
  type ContentPart,
  type ToolDefinition,
} from "../core/types";
import { normalizeContent } from "../message/modality";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import { BLACKBOARD_KEYS } from "../defaults/blackboard-vars";
import type { LLMMessage } from "../llm/types";
import { findByName } from "../utils/name-lookup";

const COMPACTED_TOOL_PLACEHOLDER = "[Old tool result content cleared]";

function isHeavyContentPart(p: ContentPart): boolean {
  return isMediaContentPart(p) || p.type === "file" || p.type === "text_file";
}

/** Protection-zone thresholds shared by microCompact and partialCompact。 */
export interface CompactProtectionZone {
  /** 最近 N 条 tool_result 不动（默认走 AGENT_DEFAULTS.historyKeep.recentTools）。 */
  keepRecentTools?: number;
  /** 最近 N 条带 heavy media 的 message 不动（默认走 historyKeep.recentMedias）。 */
  keepRecentMedias?: number;
}

export interface MicroCompactConfig extends CompactProtectionZone {
  /** Idle-gap 阈值（ms）；< 时跳过压缩。默认 20min（AGENT_DEFAULTS.historyKeep.idleGapMs）。 */
  idleGapMs?: number;
  /** 上次 user_input 的 ts（ms）；undefined 当 "从未观察到" → 视作 idle。 */
  lastUserInputAt?: number;
  /** 当前 tool 列表 —— 用 ToolDefinition.compactResult 做按工具压缩。 */
  toolDefs?: ReadonlyArray<Pick<ToolDefinition, "name" | "compactResult">>;
}

export function microCompact(messages: LLMMessage[], config: MicroCompactConfig = {}): LLMMessage[] {
  const keepTool = config.keepRecentTools ?? AGENT_DEFAULTS.historyKeep.recentTools;
  const keepMedia = config.keepRecentMedias ?? AGENT_DEFAULTS.historyKeep.recentMedias;
  const idleGapMs = config.idleGapMs ?? AGENT_DEFAULTS.historyKeep.idleGapMs;
  const lastUserInputAt = config.lastUserInputAt;

  const idle = lastUserInputAt === undefined || (Date.now() - lastUserInputAt) >= idleGapMs;
  if (!idle) return messages;

  const toolDefs = config.toolDefs ?? [];

  const toolIndices: number[] = [];
  const mediaIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") toolIndices.push(i);
    if (Array.isArray(msg.content) && msg.content.some(isHeavyContentPart)) {
      mediaIndices.push(i);
    }
  }
  const toolCompactSet = new Set<number>(toolIndices.slice(0, Math.max(0, toolIndices.length - keepTool)));
  const oldMediaSet = new Set<number>(mediaIndices.slice(0, Math.max(0, mediaIndices.length - keepMedia)));

  return messages.map((msg, i) => {
    if (toolCompactSet.has(i) && msg.role === "tool") {
      const toolName = findToolName(messages, msg.toolCallId);
      const compact = findByName(toolDefs, toolName)?.compactResult;
      if (compact) {
        const rawText = (msg.content ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const args = findToolArgs(messages, msg.toolCallId);
        const compressed = compact(args, rawText);
        if (compressed === null) return msg;
        return { ...msg, content: normalizeContent(compressed), truncated: true };
      }
      return { ...msg, content: [{ type: "text" as const, text: COMPACTED_TOOL_PLACEHOLDER }], truncated: true };
    }
    if (oldMediaSet.has(i) && Array.isArray(msg.content)) {
      const filtered: ContentPart[] = msg.content.map((p) => {
        if (p.type === "file") return { type: "text" as const, text: `[file: ${p.path} (${p.mimeType})]` };
        if (p.type === "text_file") return { type: "text" as const, text: `[file: ${p.path}]` };
        if (isFileMediaContentPart(p)) return { type: "text" as const, text: `[${p.type}: ${p.path}]` };
        if (isInlineMediaContentPart(p)) return { type: "text" as const, text: `[${p.type} removed]` };
        return p;
      });
      return { ...msg, content: filtered, truncated: true };
    }
    return msg;
  });
}

// ── Idle anchor helpers (LAST_USER_INPUT_AT in blackboard) ──────────────────

/** Scan event batch for `user_input` events，把最大 ts 写到 blackboard。
 *  ConsciousAgent 在 process() 起始调用一次。 */
export function trackUserInput(
  events: ReadonlyArray<{ type: string; ts: number }>,
  blackboard: { set(agentId: string, key: string, value: unknown, opts: { persist: boolean }): void },
  agentId: string,
): void {
  let latest = 0;
  for (const ev of events) {
    if (ev.type === "user_input" && typeof ev.ts === "number" && ev.ts > latest) latest = ev.ts;
  }
  if (latest > 0) blackboard.set(agentId, BLACKBOARD_KEYS.LAST_USER_INPUT_AT, latest, { persist: true });
}

/** Read persisted idle anchor。 */
export function getLastUserInputAt(
  blackboard: { get(agentId: string, key: string): unknown },
  agentId: string,
): number | undefined {
  const v = blackboard.get(agentId, BLACKBOARD_KEYS.LAST_USER_INPUT_AT);
  return typeof v === "number" ? v : undefined;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function findToolName(messages: LLMMessage[], toolCallId?: string): string {
  if (!toolCallId) return "unknown_tool";
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId === toolCallId && msg.toolName) return msg.toolName;
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find((t) => t.id === toolCallId);
      if (tc) return tc.name;
    }
  }
  return "unknown_tool";
}

function findToolArgs(messages: LLMMessage[], toolCallId?: string): Record<string, unknown> {
  if (!toolCallId) return {};
  for (const msg of messages) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find((t) => t.id === toolCallId);
      if (tc) return tc.arguments ?? {};
    }
  }
  return {};
}
