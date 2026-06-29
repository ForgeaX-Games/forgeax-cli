/** summary-compaction —— 容量触发 / 边界滚动的全量压缩。
 *
 *  与 agenteam ref 718 行 1:1（plan §3.8）；只把 `ConsciousAgent.resolveModelsConfig`
 *  解耦成 caller 注入的 `resolveModels: () => ModelsConfig`，避免 context-window
 *  反向依赖 conscious-agent。SessionManager 对应替换成 LedgerReader（buildPrompt
 *  / getWindowEventsRaw 只用到这个最小接口）。
 *
 *  两个入口：
 *  - `partialCompact` —— 增量段落压缩，发 `partial_boundary` event。
 *  - `fullCompact`    —— 日切边界全量合并，发 `compact_boundary` event。
 *
 *  Per-agent lock 保证 partial / full 互斥（一棵 agent 同时只能跑一个）。 */

import type { EventBusAPI, ModelsConfig } from "../core/types";
import type { LLMMessage } from "../llm/types";
import type { StoredEvent } from "../ledger/types";
import { ContextWindow, locateBoundaries, type LedgerReader } from "./context-window";
import { eventsToMessages } from "./history-pipeline";
import { normalizeHistory } from "./tool-normalizer";
import type { CompactProtectionZone } from "./micro-compaction";
import { normalizeContent } from "../message/modality";
import { createProvider, getModelSpec } from "../llm/provider";
import { assembleResponse } from "../llm/stream";
import { extractMessageBodyText } from "../llm/thinking";
import { randomUUID } from "node:crypto";

// ─── Per-agent lock ─────────────────────────────────────────────────────────

const _compactionLocks = new Map<string, boolean>();

// ─── Constants ──────────────────────────────────────────────────────────────

const KEEP_USER_MSGS = 3;
const MIN_MESSAGES = 4;

const SUMMARY_MIN_OUTPUT_TOKENS = 10_000;
// Caps must comfortably exceed the largest thinking budget caller might inherit
// (Anthropic Sonnet 4.6 high effort = 32768) plus reply headroom — otherwise the
// API rejects with `max_tokens must be greater than thinking.budget_tokens`.
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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/** Find protection-zone cutoff (index of first event in the protection zone)。
 *  从 tail 倒数 keepUserMsgs 条 user message；落到该 user message 的 idx，
 *  保证从那条开始切片不破坏 tool_use ↔ tool_result 配对。 */
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

// ─── Shared init ────────────────────────────────────────────────────────────

interface CompactionContext {
  rawEvents: StoredEvent[];
  normalizedMessages: LLMMessage[];
  modelName: string;
  modelsConfig: ModelsConfig;
  boundaryInfo: ReturnType<typeof locateBoundaries>;
  /** Index of last boundary event；无 boundary 则 -1。 */
  lastBoundaryIdx: number;
  /** Index of first event in protection zone；保护区为空则等于 rawEvents.length。 */
  cutoffIdx: number;
  tokensBefore: number;
}

async function prepareCompaction(
  agentId: string,
  ledger: LedgerReader,
  resolveModels: () => ModelsConfig,
): Promise<CompactionContext | CompactionResult> {
  const cw = new ContextWindow(agentId, ledger);
  const rawEvents = await cw.getWindowEventsRaw();

  const allMessages = eventsToMessages(rawEvents);
  const { messages: normalizedMessages } = normalizeHistory(allMessages);

  if (normalizedMessages.length < MIN_MESSAGES) {
    return { ok: false, reason: `Session too short to compact (fewer than ${MIN_MESSAGES} messages).` };
  }

  let modelsConfig: ModelsConfig;
  let modelName: string;
  try {
    modelsConfig = resolveModels();
    const m = Array.isArray(modelsConfig.model) ? modelsConfig.model[0] : (modelsConfig.model ?? undefined);
    if (!m) throw new Error("No model configured for compaction — set models.model in agent.json or session.defaultModels");
    modelName = m;
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? "No model available for compaction." };
  }

  const boundaryInfo = locateBoundaries(rawEvents);
  const lastBoundaryIdx = boundaryInfo
    ? boundaryInfo.boundaries[boundaryInfo.boundaries.length - 1].idx
    : -1;
  const cutoffIdx = findProtectionCutoffIdx(rawEvents, lastBoundaryIdx, KEEP_USER_MSGS);
  const tokensBefore = getTokensBefore(rawEvents);

  return { rawEvents, normalizedMessages, modelName, modelsConfig, boundaryInfo, lastBoundaryIdx, cutoffIdx, tokensBefore };
}

function isEarlyExit(r: CompactionContext | CompactionResult): r is CompactionResult {
  return "ok" in r;
}

// ═══════════════════════════════════════════════════════════════════════════
//  partialCompact —— incremental segment summarization
// ═══════════════════════════════════════════════════════════════════════════

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

FINAL REMINDER: Sections 7, 8, and 9 are the most important parts of this summary. A summary missing these sections is USELESS for continuing work. Budget your output accordingly — shorten sections 3-5 if needed, but NEVER omit 7-9.

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
</example>`;

export interface PartialCompactOptions extends CompactProtectionZone {
  agentId: string;
  ledger: LedgerReader;
  eventBus: EventBusAPI;
  resolveModels: () => ModelsConfig;
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

export async function partialCompact(options: PartialCompactOptions): Promise<CompactionResult> {
  const { agentId, ledger, eventBus, resolveModels, signal, instructions } = options;

  const prepared = await prepareCompaction(agentId, ledger, resolveModels);
  if (isEarlyExit(prepared)) return prepared;

  const { rawEvents, normalizedMessages, modelName, modelsConfig, boundaryInfo, lastBoundaryIdx, cutoffIdx, tokensBefore } = prepared;

  const lastB = boundaryInfo?.boundaries[boundaryInfo.boundaries.length - 1];
  const prevSummary = lastB?.summary ?? "";

  const segmentEvents = rawEvents.slice(lastBoundaryIdx + 1, cutoffIdx);
  const { messages: segmentNormalized } = normalizeHistory(eventsToMessages(segmentEvents));
  if (segmentNormalized.length === 0) {
    return { ok: false, reason: "Nothing to summarize — no events between last boundary and protection zone." };
  }
  const conversationText = segmentNormalized.map(serializeMessageForSummary).join("\n");

  let contextSuffix = "";
  if (lastB?.type === "partial" && lastB.summarizedRange.toTs > 0) {
    const prevBIdx = boundaryInfo!.boundaries.length >= 2
      ? boundaryInfo!.boundaries[boundaryInfo!.boundaries.length - 2].idx
      : -1;
    const lastToTs = lastB.summarizedRange.toTs;
    const oldProtEvents = rawEvents.slice(prevBIdx + 1, lastBoundaryIdx)
      .filter((e) => e.ts >= lastToTs && e.type !== "compact_boundary" && e.type !== "partial_boundary");
    const { messages: oldProtNorm } = normalizeHistory(eventsToMessages(oldProtEvents));
    if (oldProtNorm.length > 0) {
      const oldProtText = oldProtNorm.map(serializeMessageForSummary).join("\n");
      contextSuffix += `\n\n--- Previous Protection Zone (${oldProtNorm.length} messages — unsummarized, capture key state) ---\n${oldProtText}\n--- End Previous Protection Zone ---`;
    }
  }

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
  if (instructions) systemPrompt += `\n\n## Custom Compact Instructions\n${instructions}`;

  let summarizeUsage: { inputTokens: number; outputTokens: number } | undefined;

  const maxTokens = resolveSummaryMaxTokens(modelName);
  const provider = createProvider({
    ...modelsConfig,
    model: modelName,
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

/** Thin wrapper with per-agent lock。auto_compact daemon / `/compact` slash 用。 */
export async function compactCurrentSession(options: PartialCompactOptions): Promise<CompactionResult> {
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
//  fullCompact —— day-boundary merge of all segments
// ═══════════════════════════════════════════════════════════════════════════

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
2. Key Technical Concepts
3. Files and Changes
4. Errors and Fixes
5. Problem Solving
6. User Messages
7. Completed Work (MANDATORY — do NOT skip)
8. Pending Tasks (MANDATORY — do NOT skip)
9. Current State and Next Step (MANDATORY — do NOT skip)
10. Persistent Context (MANDATORY — full compaction only)
    Long-lived information that should survive indefinitely:
    - User preferences and conventions
    - Project structure and architecture understanding
    - Tool/workflow patterns that worked well or poorly
    - Commitments made to the user
    - Active branches, PR states, deploy states

FINAL REMINDER: This is a day-boundary compaction. Detailed history lives on disk; this summary is a navigation aid. Prioritize: current context > long-lived facts > compressed older history. Drop noise.`;

export interface FullCompactOptions {
  agentId: string;
  ledger: LedgerReader;
  eventBus: EventBusAPI;
  resolveModels: () => ModelsConfig;
  signal: AbortSignal;
}

export interface CompactBoundaryPayload {
  summary: string;
  keepCount: number;
  mergedSegments?: string[];
  createdAt: number;
}

export async function fullCompact(options: FullCompactOptions): Promise<CompactionResult> {
  const { agentId } = options;

  if (_compactionLocks.get(agentId)) {
    return { ok: false, reason: "Compaction already in progress for this agent — skipping." };
  }
  _compactionLocks.set(agentId, true);

  try {
    return await _fullCompactInner(options);
  } finally {
    _compactionLocks.delete(agentId);
  }
}

async function _fullCompactInner(options: FullCompactOptions): Promise<CompactionResult> {
  const { agentId, ledger, eventBus, resolveModels, signal } = options;

  const prepared = await prepareCompaction(agentId, ledger, resolveModels);
  if (isEarlyExit(prepared)) return prepared;

  const { rawEvents, normalizedMessages, modelName, modelsConfig, boundaryInfo, cutoffIdx, tokensBefore } = prepared;

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
    ...modelsConfig,
    model: modelName,
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
