// @desc Micro-compaction — idle-gap gated, byte-stable; safe for all providers' prefix caches
import { isMediaContentPart, isInlineMediaContentPart, isFileMediaContentPart, type ContentPart } from "../core/types.js";
import type { ToolDefinition } from "../core/types.js";
import { normalizeContent } from "../message/modality.js";
import { AGENT_DEFAULTS } from "../defaults/agent/agent-json.js";
import type { LLMMessage } from "../llm/types.js";
import { findByName } from "../registries/name-lookup.js";
import { TEAMBOARD_KEYS } from "../defaults/teamboard-vars.js";

const COMPACTED_TOOL_PLACEHOLDER = "[Old tool result content cleared]";

function isHeavyContentPart(p: ContentPart): boolean {
  return isMediaContentPart(p) || p.type === "file" || p.type === "text_file";
}

/** Protection-zone thresholds shared by microCompact and partialCompact. */
export interface CompactProtectionZone {
  /** Keep the most recent N tool results uncompacted (default 20). */
  keepRecentTools?: number;
  /** Keep the most recent N messages carrying heavy media (image/file/video/…) uncompacted (default 2). */
  keepRecentMedias?: number;
}

/** Full microCompact config — extends protection zone with idle-gap gate fields. */
export interface MicroCompactConfig extends CompactProtectionZone {
  /**
   * Idle-gap threshold (ms): compaction only runs when
   * `now - lastUserInputAt >= idleGapMs`. Default 20 minutes.
   *
   * The anchor is the last real user input (`type === "user_input"` event).
   * Self-driven turns (mr_tracker, child agent messages, heartbeat) don't
   * reset this anchor — they are framework-internal and don't indicate user
   * presence. 20 minutes without user input means all provider caches
   * (Anthropic ephemeral 5min, OpenAI/DeepSeek implicit, Gemini) have
   * naturally expired, making byte mutation safe.
   */
  idleGapMs?: number;
  /**
   * Wall-clock ts (ms) of the last `type === "user_input"` event for this
   * agent (read from teamboard's LAST_USER_INPUT_AT). `undefined` is treated
   * as "no user input ever observed" → idle.
   */
  lastUserInputAt?: number;
  /** Current tool definitions — used to look up per-tool compactResult strategies. */
  toolDefs?: ReadonlyArray<Pick<ToolDefinition, "name" | "compactResult">>;
}

/**
 * Compact old tool_results / heavy media outside the "keep recent" zone.
 *
 * Trigger: a single global idle-gap check — `now - lastUserInputAt >= idleGapMs`.
 * Until that gap is crossed, history is returned byte-identical so providers'
 * prefix caches keep matching across turns. Once it crosses, every candidate
 * outside the protection zone is compacted:
 *
 *   • Tool has `compactResult` → call it; return value replaces content.
 *     Return null to skip (preserve as-is). Return the original result to
 *     keep content unchanged (explicit preservation).
 *   • Tool has NO `compactResult` → fixed placeholder (default clear).
 */
export function microCompact(messages: LLMMessage[], config: MicroCompactConfig = {}): LLMMessage[] {
  const keepTool = config.keepRecentTools ?? AGENT_DEFAULTS.session.keepRecentTools;
  const keepMedia = config.keepRecentMedias ?? AGENT_DEFAULTS.session.keepRecentMedias;
  const idleGapMs = config.idleGapMs ?? AGENT_DEFAULTS.session.idleGapMs;
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
          .map(p => p.text)
          .join("\n");
        const args = findToolArgs(messages, msg.toolCallId);
        const compressed = compact(args, rawText);
        if (compressed === null) return msg;
        return { ...msg, content: normalizeContent(compressed), truncated: true };
      }
      // No compactResult → default: fixed placeholder
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

// ── Idle anchor helpers (encapsulate LAST_USER_INPUT_AT tracking) ──

/**
 * Scan an event batch for `user_input` events and persist the latest ts
 * to teamboard. Called once per turn from conscious-agent's `process()`.
 */
export function trackUserInput(
  events: ReadonlyArray<{ type: string; ts: number }>,
  teamBoard: { set(agentId: string, key: string, value: unknown, opts: { persist: boolean }): void },
  agentId: string,
): void {
  let latest = 0;
  for (const ev of events) {
    if (ev.type === "user_input" && typeof ev.ts === "number" && ev.ts > latest) latest = ev.ts;
  }
  if (latest > 0) teamBoard.set(agentId, TEAMBOARD_KEYS.LAST_USER_INPUT_AT, latest, { persist: true });
}

/** Read the persisted idle anchor from teamboard. */
export function getLastUserInputAt(
  teamBoard: { get(agentId: string, key: string): unknown },
  agentId: string,
): number | undefined {
  const v = teamBoard.get(agentId, TEAMBOARD_KEYS.LAST_USER_INPUT_AT);
  return typeof v === "number" ? v : undefined;
}

// ── Internal helpers ──

function findToolName(messages: LLMMessage[], toolCallId?: string): string {
  if (!toolCallId) return "unknown_tool";
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId === toolCallId && msg.toolName) return msg.toolName;
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find(t => t.id === toolCallId);
      if (tc) return tc.name;
    }
  }
  return "unknown_tool";
}

function findToolArgs(messages: LLMMessage[], toolCallId?: string): Record<string, unknown> {
  if (!toolCallId) return {};
  for (const msg of messages) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find(t => t.id === toolCallId);
      if (tc) return tc.arguments ?? {};
    }
  }
  return {};
}
