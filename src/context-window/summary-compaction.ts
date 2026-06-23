import type { AgentJson, EventBusAPI } from "../core/types.js";
import type { AgentLedgerAPI } from "../session/types.js";
import { ConsciousAgent } from "../core/conscious-agent.js";
import { ContextWindow, locateBoundaries } from "./context-window.js";
import { normalizeContent } from "../message/modality.js";
import { createProvider, getModelSpec } from "../llm/provider.js";
import { assembleResponse } from "../llm/stream.js";
import { extractMessageBodyText } from "../llm/thinking.js";
import type { LLMMessage } from "../llm/types.js";
import { eventsToMessages } from "./history-pipeline.js";
import { normalizeHistory } from "./tool-normalizer.js";
import type { StoredEvent } from "./system-snapshot.js";
import type { CompactProtectionZone } from "./micro-compaction.js";
import { randomUUID } from "node:crypto";

/** Per-agent lock — shared between partial and full compaction (mutually exclusive). */
const _compactionLocks = new Map<string, boolean>();

/**
 * Protection zone size: keep the most-recent N user messages uncompacted.
 * If the post-boundary stream has fewer than this many user messages,
 * compact everything (full-stream compaction degenerates gracefully).
 */
const KEEP_USER_MSGS = 3;
const MIN_MESSAGES = 4;

const SUMMARY_MIN_OUTPUT_TOKENS = 10_000;
// Caps below must comfortably exceed the largest thinking budget any caller might inherit
// (Anthropic Sonnet 4.6 high effort = 32768) plus reply headroom — otherwise the Anthropic
// API rejects the request with `max_tokens must be greater than thinking.budget_tokens`.
const SUMMARY_MAX_OUTPUT_TOKENS = 40_000;
const FULL_COMPACT_MAX_OUTPUT_TOKENS = 40_000;

// ─── Shared types ───────────────────────────────────────────────────────────

export type CompactionResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      boundaryTs: number;
      originalMessageCount: number;
      newMessageCount: number;
      tokensBefore: number;
      summarizeUsage?: { inputTokens: number; outputTokens: number };
    };

// ─── Shared helpers ─────────────────────────────────────────────────────────

function resolveCompactionModel(getAgentJson: () => AgentJson): string {
  const mc = ConsciousAgent.resolveModelsConfig(getAgentJson());
  const model = Array.isArray(mc.model) ? mc.model[0] : (mc.model ?? undefined);
  if (model) return model;
  throw new Error("No model configured for compaction — set models.model in agent.json or agenteam.json");
}

function resolveSummaryMaxTokens(modelName: string, cap: number = SUMMARY_MAX_OUTPUT_TOKENS): number {
  const spec = getModelSpec(modelName);
  const modelMax = spec.maxOutput;
  if (!modelMax) return cap;
  return Math.min(cap, Math.max(SUMMARY_MIN_OUTPUT_TOKENS, modelMax));
}

function serializeMessageForSummary(m: LLMMessage): string {
  const roleTag = m.role === "tool" ? `[tool:${m.toolName ?? "unknown"}]` : `[${m.role}]`;
  const text = extractMessageBodyText(m) || (Array.isArray(m.content) ? "[multimodal]" : "");
  return `${roleTag} ${text}`;
}

function extractSummaryBlock(raw: string): string {
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) return summaryMatch[1].trim();

  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
  return withoutAnalysis || raw;
}

/**
 * Find the protection-zone cutoff (the index of its first event).
 *
 * Walks backwards from the tail (stopping at `lastBoundaryIdx`) and counts
 * `role: "user"` LLMMessage events. When the N-th one is reached, returns its
 * index — that user message marks the start of the protection zone.
 *
 * Why land on a user message: it's a natural "new turn / new intent" boundary.
 * Splitting *before* one is always safe — the previous turn's assistant +
 * tool_use blocks + their tool_results are all already complete. Never splits
 * mid-thinking, never breaks a tool_use ↔ tool_result pair.
 *
 * If the stream has fewer than `keepUserMsgs` user messages after the last
 * boundary, returns `events.length` — meaning the protection zone is empty
 * and the caller should compact the entire post-boundary segment.
 */
function findProtectionCutoffIdx(
  events: StoredEvent[],
  lastBoundaryIdx: number,
  keepUserMsgs: number,
): number {
  let userCount = 0;
  for (let i = events.length - 1; i > lastBoundaryIdx; i--) {
    const llmMsg = events[i].payload?.llmMessage as LLMMessage | undefined;
    if (llmMsg?.role === "user") {
      if (++userCount >= keepUserMsgs) return i;
    }
  }
  return events.length;
}

function getTokensBefore(events: StoredEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const u = events[i].payload?.usage as { inputTokens: number; outputTokens: number } | undefined;
    if (u) return u.inputTokens + u.outputTokens;
  }
  return 0;
}

// ─── Shared initialization (used by both partial and full compact) ──────────

interface CompactionContext {
  rawEvents: StoredEvent[];
  normalizedMessages: LLMMessage[];
  modelName: string;
  boundaryInfo: ReturnType<typeof locateBoundaries>;
  /** Index of the last boundary event, or -1 if the stream has no prior boundary. */
  lastBoundaryIdx: number;
  /** Index of the first event in the protection zone, or `rawEvents.length` if the zone is empty (full-stream compaction). */
  cutoffIdx: number;
  tokensBefore: number;
}

/**
 * Common initialization for both partial and full compaction:
 * read events, normalize, resolve model, locate boundaries, find protection zone.
 *
 * Returns CompactionContext on success, or CompactionResult (ok: false) on early exit.
 */
async function prepareCompaction(
  agentId: string,
  ledger: AgentLedgerAPI,
  getAgentJson: () => AgentJson,
): Promise<CompactionContext | CompactionResult> {
  const cw = new ContextWindow(agentId, ledger);
  const rawEvents = await cw.getWindowEventsRaw();

  const allMessages = eventsToMessages(rawEvents);
  const { messages: normalizedMessages } = normalizeHistory(allMessages);

  if (normalizedMessages.length < MIN_MESSAGES) {
    return { ok: false, reason: `Session too short to compact (fewer than ${MIN_MESSAGES} messages).` };
  }

  let modelName: string;
  try {
    modelName = resolveCompactionModel(getAgentJson);
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? "No model available for compaction." };
  }

  const boundaryInfo = locateBoundaries(rawEvents);
  const lastBoundaryIdx = boundaryInfo
    ? boundaryInfo.boundaries[boundaryInfo.boundaries.length - 1].idx
    : -1;
  const cutoffIdx = findProtectionCutoffIdx(rawEvents, lastBoundaryIdx, KEEP_USER_MSGS);
  const tokensBefore = getTokensBefore(rawEvents);

  return { rawEvents, normalizedMessages, modelName, boundaryInfo, lastBoundaryIdx, cutoffIdx, tokensBefore };
}

/** Type guard: distinguish early-exit result from successful context. */
function isEarlyExit(r: CompactionContext | CompactionResult): r is CompactionResult {
  return "ok" in r;
}

// ═══════════════════════════════════════════════════════════════════════════
//  partialCompact — incremental segment summarization
// ═══════════════════════════════════════════════════════════════════════════

// Key design decisions (learned from the reference agent CLI + our own truncation incident):
//
// 1. Sections 7-9 (task state) are NON-NEGOTIABLE — they MUST appear even if
//    earlier sections need to be shortened. This is the #1 cause of post-compact
//    amnesia: the model spends all output tokens on code snippets and never
//    writes what was completed vs what's pending.
//
// 2. Code snippets should be BRIEF (signature + key lines only). The full code
//    exists on disk; the summary exists to preserve *intent and progress*.
//
// 3. analysis block is a scratchpad — stripped before injection.

const SUMMARIZE_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests, your previous actions, and — most critically — the current task progress.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis:
1. Chronologically trace the conversation, identifying user requests, your actions, key decisions, errors encountered, and user feedback.
2. Pay special attention to what has been COMPLETED vs what is still PENDING.
3. Double-check technical accuracy.

CRITICAL OUTPUT RULES:
- Sections 7, 8, and 9 below are MANDATORY and must ALWAYS be included, even if you need to shorten earlier sections to fit.
- For code, include only function signatures and key 1-3 line snippets — do NOT reproduce full file contents. The code exists on disk; your job is to preserve intent and progress.
- Do NOT reproduce or reformat the raw conversation — synthesize in your own words.

Your summary MUST include ALL of the following sections, in this order:

1. Primary Request and Intent
   Capture the user's explicit requests and evolving intent throughout the conversation.

2. Key Technical Concepts
   List important technical concepts, patterns, and architectural decisions discussed.

3. Files and Changes
   For each important file: path, why it matters, what changed (1-2 sentence summary). Do NOT include full code — only brief signatures or key lines if essential.

4. Errors and Fixes
   List errors encountered and how they were resolved. Include user corrections.

5. Problem Solving
   Document solved problems and any ongoing troubleshooting.

6. User Messages
   List ALL non-tool-result user messages — these reveal intent changes and feedback.

7. Completed Work (MANDATORY — do NOT skip)
   Explicitly list what has been DONE. Include:
   - Tasks/phases completed and their outcomes
   - PRs submitted, branches pushed, commits made
   - Configurations applied, files created/deleted/moved
   This section prevents re-doing finished work after compaction.

8. Pending Tasks (MANDATORY — do NOT skip)
   List tasks that are explicitly still TODO. Distinguish between:
   - Tasks the user asked for that haven't started
   - Tasks partially done (describe exactly where you left off)

9. Current State and Next Step (MANDATORY — do NOT skip)
   Describe precisely what was happening RIGHT BEFORE this summary. Include:
   - The exact task in progress
   - Any relevant file paths or state
   - What the immediate next action should be
   If the last task was concluded, say so and only list next steps explicitly requested by the user.
   Include direct quotes from the most recent conversation showing where you left off.

<example>
<analysis>
[Chronological trace of conversation — what happened, what was completed, what's pending]
</analysis>

<summary>
1. Primary Request and Intent:
   [Description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Changes:
   - path/to/file.ts — [why important, what changed in 1-2 sentences]
   - path/to/other.ts — [summary]

4. Errors and Fixes:
   - [Error]: [How fixed]

5. Problem Solving:
   [Description]

6. User Messages:
   - [User message 1]
   - [User message 2]

7. Completed Work:
   - Phase 1: [done, outcome]
   - Phase 2: [done, outcome]
   - PR #N submitted to branch X

8. Pending Tasks:
   - [Task still TODO]
   - [Task partially done — left off at ...]

9. Current State and Next Step:
   [Exactly what was being worked on, where it stopped, what comes next]
   User's last instruction: "[verbatim quote]"
</summary>
</example>

FINAL REMINDER: Sections 7, 8, and 9 are the most important parts of this summary. A summary missing these sections is USELESS for continuing work. Budget your output accordingly — shorten sections 3-5 if needed, but NEVER omit 7-9.`;

export interface PartialCompactOptions extends CompactProtectionZone {
  agentId: string;
  ledger: AgentLedgerAPI;
  eventBus: EventBusAPI;
  getAgentJson: () => AgentJson;
  signal: AbortSignal;
  instructions?: string;
}

export interface PartialBoundaryPayload {
  summary: string;
  segmentId: string;
  createdAt: number;
  summarizedRange: {
    fromTs: number;
    toTs: number;
  };
}

export async function partialCompact(
  options: PartialCompactOptions,
): Promise<CompactionResult> {
  const {
    agentId,
    ledger,
    eventBus,
    getAgentJson,
    signal,
    instructions,
  } = options;

  const prepared = await prepareCompaction(agentId, ledger, getAgentJson);
  if (isEarlyExit(prepared)) return prepared;

  const { rawEvents, normalizedMessages, modelName, boundaryInfo, lastBoundaryIdx, cutoffIdx, tokensBefore } = prepared;

  const lastB = boundaryInfo?.boundaries[boundaryInfo.boundaries.length - 1];
  const prevSummary = lastB?.summary ?? "";

  const segmentEvents = rawEvents.slice(lastBoundaryIdx + 1, cutoffIdx);
  const { messages: segmentNormalized } = normalizeHistory(eventsToMessages(segmentEvents));
  if (segmentNormalized.length === 0) {
    return { ok: false, reason: "Nothing to summarize — no events between last boundary and protection zone." };
  }
  const conversationText = segmentNormalized.map(serializeMessageForSummary).join("\n");

  // Build context suffix: previous boundary's protection zone + current protection zone.
  // Both are unsummarized recent context the model needs to capture key state from.
  let contextSuffix = "";

  // Previous boundary's protection zone (events between prev-prev boundary and last
  // boundary, with ts >= last boundary's toTs). These were kept by toTs logic before
  // and will be dropped once this new boundary supersedes the last one.
  if (lastB?.type === "partial" && lastB.summarizedRange.toTs > 0) {
    const prevBIdx = boundaryInfo!.boundaries.length >= 2
      ? boundaryInfo!.boundaries[boundaryInfo!.boundaries.length - 2].idx
      : -1;
    const lastToTs = lastB.summarizedRange.toTs;
    const oldProtEvents = rawEvents.slice(prevBIdx + 1, lastBoundaryIdx)
      .filter(e => e.ts >= lastToTs && e.type !== "compact_boundary" && e.type !== "partial_boundary");
    const { messages: oldProtNorm } = normalizeHistory(eventsToMessages(oldProtEvents));
    if (oldProtNorm.length > 0) {
      const oldProtText = oldProtNorm.map(serializeMessageForSummary).join("\n");
      contextSuffix += `\n\n--- Previous Protection Zone (${oldProtNorm.length} messages — unsummarized, capture key state) ---\n${oldProtText}\n--- End Previous Protection Zone ---`;
    }
  }

  // Current protection zone: events after cutoffIdx — not being compressed in this round.
  const { messages: protNormalized } = normalizeHistory(eventsToMessages(rawEvents.slice(cutoffIdx)));
  if (protNormalized.length > 0) {
    const protText = protNormalized.map(serializeMessageForSummary).join("\n");
    contextSuffix += `\n\n--- Current Protection Zone (${protNormalized.length} recent messages — for context) ---\n${protText}\n--- End Current Protection Zone ---`;
  }

  let contextPrefix = "";
  if (prevSummary) {
    contextPrefix = `## Previous Session Summary\n\n${prevSummary}\n\n---\n\n`;
  }

  let systemPrompt = SUMMARIZE_PROMPT;
  if (instructions) {
    systemPrompt += `\n\n## Custom Compact Instructions\n${instructions}`;
  }

  let summarizeUsage: { inputTokens: number; outputTokens: number } | undefined;

  const maxTokens = resolveSummaryMaxTokens(modelName);
  const provider = createProvider({
    ...ConsciousAgent.resolveModelsConfig(getAgentJson()),
    maxTokens,
    showThinking: false,
    temperature: 0.3,
  });

  const stream = provider.chatStream(
    [{ name: "summarizer", text: systemPrompt, cacheHint: "stable", priority: 0 }],
    [
      {
        role: "user",
        content: normalizeContent(
          `${contextPrefix}Below is a conversation segment (${segmentNormalized.length} messages) that needs to be summarized.` +
          `${contextSuffix ? " Protection zones show unsummarized context — capture their key state in sections 7-9." : ""}\n\n` +
          `--- Conversation Segment ---\n${conversationText}\n--- End ---${contextSuffix}`,
        ),
      },
    ],
    [],
    signal,
  );
  const resp = await assembleResponse(stream);
  if (resp.usage) {
    summarizeUsage = { inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens };
  }
  const rawSummary = typeof resp.content === "string" ? resp.content : "[summary generation failed]";
  const summaryText = extractSummaryBlock(rawSummary);

  const boundaryTs = Date.now();
  const fromTs = segmentEvents[0]?.ts ?? boundaryTs;
  // toTs anchors the protection zone in the event stream by *timestamp* so that
  // events written during the async summarize call (which arrive after cutoffIdx
  // was captured) are still correctly classified as "protected, not summarized"
  // on replay. cutoffIdx === rawEvents.length means full-stream compaction —
  // protection zone is empty, fall back to boundaryTs.
  const toTs = rawEvents[cutoffIdx]?.ts ?? boundaryTs;

  const payload: PartialBoundaryPayload = {
    summary: summaryText,
    segmentId: randomUUID(),
    createdAt: boundaryTs,
    summarizedRange: { fromTs, toTs },
  };

  eventBus.publish({
    type: "partial_boundary",
    ts: boundaryTs,
    source: "system",
    payload: payload as unknown as Record<string, unknown>,
  });

  const protectionMessageCount = eventsToMessages(rawEvents.slice(cutoffIdx)).length;

  return {
    ok: true,
    boundaryTs,
    originalMessageCount: normalizedMessages.length,
    newMessageCount: Math.max(1, 1 + protectionMessageCount),
    tokensBefore,
    summarizeUsage,
  };
}

/**
 * Thin wrapper with per-agent lock. Used by auto_compact plugin and compact tool.
 */
export async function compactCurrentSession(
  options: PartialCompactOptions,
): Promise<CompactionResult> {
  const { agentId } = options;

  if (_compactionLocks.get(agentId)) {
    return { ok: false, reason: "Compaction already in progress for this agent — skipping." };
  }
  _compactionLocks.set(agentId, true);

  try {
    return await partialCompact(options);
  } finally {
    _compactionLocks.delete(agentId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  fullCompact — day-boundary merge of all segments
// ═══════════════════════════════════════════════════════════════════════════

// More conservative than SUMMARIZE_PROMPT — this is the last compaction
// before the agent enters a new day, so information loss here is effectively
// permanent. Uses higher token budget and an extra "Persistent Context" section.

const MERGE_PROMPT = `You are performing a DAY-BOUNDARY FULL COMPACTION — merging multiple session summary segments into a single comprehensive summary. This is the LAST compaction before the agent enters a new day. Information not preserved here is effectively LOST from working memory.

INPUTS:
- "Prior Complete Summary" (if present): a summary from a PREVIOUS full compaction, covering older history. This is NOT raw conversation — it is already compressed.
- One or more "Summary Segment" blocks: partial compaction summaries created during the current period.
- "Recent Uncompacted Messages": raw conversation not yet summarized.
- "Protection Zone": recent messages for context only (they will NOT be replaced by this compaction).

MERGE STRATEGY — CURATE, DON'T ACCUMULATE:
The goal is NOT to append new information to old. It is to produce a single curated summary that serves the agent going forward. Treat this as editorial work:

For content from "Prior Complete Summary" (older history):
1. EXTRACT what is still relevant to ongoing work — active goals, unfinished tasks, recent decisions that still apply.
2. PRESERVE long-lived facts that matter across days — user preferences, project architecture, naming conventions, workflow patterns, commitments made, recurring error patterns and their fixes.
3. COMPRESS completed work from older days into brief one-line entries (e.g. "Day N: implemented X, fixed Y"). The details are in daily log files on disk — the summary only needs enough to avoid re-doing finished work.
4. DROP information that is fully obsolete — resolved bugs with no recurring pattern, intermediate debugging steps that led nowhere, file paths no longer relevant, user messages whose intent has been superseded.

For content from current-period segments and uncompacted messages:
5. Keep FULL DETAIL — this is the most recent context and the agent needs it intact.
6. When current info contradicts older info, the current version wins. Drop the stale version entirely.

General rules:
7. Deduplicate across all inputs — keep the most recent and detailed version of each fact.
8. Active file paths and their roles: keep the FULL list for current-period work; for older periods, only keep paths still actively referenced.

Before your summary, wrap analysis in <analysis> tags:
1. Triage the "Prior Complete Summary": for each piece of information, decide EXTRACT / PRESERVE / COMPRESS / DROP and state why.
2. List every current-period segment's key contributions.
3. Identify contradictions between old and new, and resolve them (new wins).

CRITICAL OUTPUT RULES:
- Output token budget is GENEROUS — use it. Err on the side of keeping more, not less.
- Sections 7, 8, 9 are NON-NEGOTIABLE (same as partial compaction).
- Section 10 (Persistent Context) is NEW and MANDATORY for full compaction.
- Do NOT reproduce full code — only function signatures and key lines.

Your summary MUST include ALL sections in this order:

1. Primary Request and Intent
   The user's CURRENT active request and goals. For older requests that are fully completed, a one-line mention is enough.

2. Key Technical Concepts
   Technical concepts, patterns, and architecture decisions that are STILL RELEVANT. Drop concepts from older work that is done and unlikely to be revisited. Always include the "why", not just the "what".

3. Files and Changes
   - Current-period files: full list with path + role + what changed.
   - Older-period files: only keep those still actively relevant. Completed work on files no longer in play can be omitted.

4. Errors and Fixes
   - Recurring or systemic error patterns: ALWAYS keep (they prevent future mistakes).
   - One-off errors from older work that were resolved and won't recur: compress to one line or drop.

5. Problem Solving
   Key insights and debugging lessons that have ongoing value. Drop step-by-step debugging traces from resolved issues unless the pattern is likely to recur.

6. User Messages
   - Current-period: ALL user messages.
   - Older periods: keep preference statements, corrections, and feedback that still apply. Drop routine task instructions that have been completed.

7. Completed Work (MANDATORY — do NOT skip)
   - Current period: detailed list with outcomes.
   - Older periods: compress into brief per-day summaries (e.g. "Apr 7: implemented fullCompact, refactored memory_curator").
   This section prevents re-doing finished work — keep enough to know what's done, no more.

8. Pending Tasks (MANDATORY — do NOT skip)
   Everything still TODO, with exact status of partially-done tasks. Drop tasks from older summaries that have since been completed (move them to Section 7).

9. Current State and Next Step (MANDATORY — do NOT skip)
   What was happening right before this summary. Include the user's most recent instruction verbatim.

10. Persistent Context (MANDATORY — full compaction only)
    Long-lived information that should survive indefinitely:
    - User preferences and conventions (communication style, coding standards, language preferences)
    - Project structure and architecture understanding
    - Tool/workflow patterns that worked well or poorly
    - Commitments made to the user (e.g. "I'll do X tomorrow")
    - Active branches, PR states, deploy states
    This section is the MOST DURABLE part of the summary — it should grow slowly and only contain facts with long shelf life.

<example>
<analysis>
[Per-segment contributions, contradictions resolved, important info flagged]
</analysis>

<summary>
1. Primary Request and Intent: ...
2. Key Technical Concepts: ...
3. Files and Changes: ...
4. Errors and Fixes: ...
5. Problem Solving: ...
6. User Messages: ...
7. Completed Work: ...
8. Pending Tasks: ...
9. Current State and Next Step: ...
10. Persistent Context: ...
</summary>
</example>

FINAL REMINDER: This is a day-boundary compaction. The agent will wake up tomorrow with this summary + its persistent memory files (MEMORY.md, knowledge/, experience/, daily logs). Your job is to produce a CURATED working memory — not a complete archive. Detailed history lives in daily log files on disk; this summary is a navigation aid that tells the agent where it stands, what matters now, and what long-term facts to remember. Prioritize: current context > long-lived facts > compressed older history. Drop noise.`;

export interface FullCompactOptions {
  agentId: string;
  ledger: AgentLedgerAPI;
  eventBus: EventBusAPI;
  getAgentJson: () => AgentJson;
  signal: AbortSignal;
}

export interface CompactBoundaryPayload {
  summary: string;
  keepCount: number;
  mergedSegments?: string[];
  createdAt: number;
}

/**
 * Full compaction: merge all existing partial_boundary summaries (and any
 * prior compact_boundary) into a single compact_boundary event.
 *
 * Used at day boundaries by memory_curator. More conservative than
 * partialCompact — uses MERGE_PROMPT with higher token budget and an
 * extra "Persistent Context" section.
 *
 * If no boundaries exist, falls back to summarizing all messages outside
 * the protection zone, writing a compact_boundary.
 */
export async function fullCompact(
  options: FullCompactOptions,
): Promise<CompactionResult> {
  const { agentId, ledger, eventBus, getAgentJson, signal } = options;

  if (_compactionLocks.get(agentId)) {
    return { ok: false, reason: "Compaction already in progress for this agent — skipping." };
  }
  _compactionLocks.set(agentId, true);

  try {
    return await _fullCompactInner(agentId, ledger, eventBus, getAgentJson, signal);
  } finally {
    _compactionLocks.delete(agentId);
  }
}

async function _fullCompactInner(
  agentId: string,
  ledger: AgentLedgerAPI,
  eventBus: EventBusAPI,
  getAgentJson: () => AgentJson,
  signal: AbortSignal,
): Promise<CompactionResult> {
  const prepared = await prepareCompaction(agentId, ledger, getAgentJson);
  if (isEarlyExit(prepared)) return prepared;

  const { rawEvents, normalizedMessages, modelName, boundaryInfo, cutoffIdx, tokensBefore } = prepared;

  // Build merge input: collect all boundary summaries + uncompacted messages
  const inputParts: string[] = [];
  const mergedSegmentIds: string[] = [];

  if (boundaryInfo) {
    for (const b of boundaryInfo.boundaries) {
      if (b.type === "compact") {
        inputParts.push(`## Prior Complete Summary\n\n${b.summary}`);
      } else {
        inputParts.push(`## Summary Segment [${b.segmentId}]\n\n${b.summary}`);
        mergedSegmentIds.push(b.segmentId);
      }
    }

    const lastB = boundaryInfo.boundaries[boundaryInfo.boundaries.length - 1];
    const uncompactedEvents = rawEvents.slice(lastB.idx + 1, cutoffIdx);
    if (uncompactedEvents.length > 0) {
      const uncompactedMsgs = eventsToMessages(uncompactedEvents);
      const { messages: normalized } = normalizeHistory(uncompactedMsgs);
      if (normalized.length > 0) {
        const text = normalized.map(serializeMessageForSummary).join("\n");
        inputParts.push(`## Recent Uncompacted Messages (${normalized.length})\n\n${text}`);
      }
    }
  } else {
    const toSummarize = rawEvents.slice(0, cutoffIdx);
    if (toSummarize.length === 0) {
      return { ok: false, reason: "No messages outside protection zone to compact." };
    }
    const msgs = eventsToMessages(toSummarize);
    const { messages: normalized } = normalizeHistory(msgs);
    if (normalized.length < MIN_MESSAGES) {
      return { ok: false, reason: "Too few messages outside protection zone." };
    }
    const text = normalized.map(serializeMessageForSummary).join("\n");
    inputParts.push(`## Full Conversation (${normalized.length} messages)\n\n${text}`);
  }

  const protectionEvents = rawEvents.slice(cutoffIdx);
  const protectionMsgs = eventsToMessages(protectionEvents);
  const { messages: protNormalized } = normalizeHistory(protectionMsgs);
  if (protNormalized.length > 0) {
    const protText = protNormalized.map(serializeMessageForSummary).join("\n");
    inputParts.push(`## Protection Zone (${protNormalized.length} recent messages — for context only)\n\n${protText}`);
  }

  const maxTokens = resolveSummaryMaxTokens(modelName, FULL_COMPACT_MAX_OUTPUT_TOKENS);
  const provider = createProvider({
    ...ConsciousAgent.resolveModelsConfig(getAgentJson()),
    maxTokens,
    showThinking: false,
    temperature: 0.3,
  });

  let summarizeUsage: { inputTokens: number; outputTokens: number } | undefined;

  const stream = provider.chatStream(
    [{ name: "full-compaction-merger", text: MERGE_PROMPT, cacheHint: "stable", priority: 0 }],
    [
      {
        role: "user",
        content: normalizeContent(inputParts.join("\n\n---\n\n")),
      },
    ],
    [],
    signal,
  );
  const resp = await assembleResponse(stream);
  if (resp.usage) {
    summarizeUsage = { inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens };
  }
  const rawSummary = typeof resp.content === "string" ? resp.content : "[summary generation failed]";
  const summaryText = extractSummaryBlock(rawSummary);

  const boundaryTs = Date.now();
  const payload: CompactBoundaryPayload = {
    summary: summaryText,
    keepCount: 0,
    mergedSegments: mergedSegmentIds.length > 0 ? mergedSegmentIds : undefined,
    createdAt: boundaryTs,
  };

  eventBus.publish({
    type: "compact_boundary",
    ts: boundaryTs,
    source: "system",
    payload: payload as unknown as Record<string, unknown>,
  });

  const protectionMessageCount = protNormalized.length;

  return {
    ok: true,
    boundaryTs,
    originalMessageCount: normalizedMessages.length,
    newMessageCount: Math.max(1, 1 + protectionMessageCount),
    tokensBefore,
    summarizeUsage,
  };
}
