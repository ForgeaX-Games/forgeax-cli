/**
 * xml.ts — Semantic XML serialization for events.jsonl visualization.
 *
 * Produces a human-readable ledger.xml that groups raw events into
 * <turn> blocks (XML-style envelope) with semantic inner tags:
 *   <thinking>, <tool_call>, <tool_output>, <system_note>, <compact>, etc.
 *
 * This is a *derived view* — events.jsonl remains the source of truth.
 * The XML is never sent to LLMs; it exists for human/AI inspection and
 * browser-based visualization.
 */

import stripAnsi from "strip-ansi";
import type { LLMMessage } from "../llm/types.js";
import type { ContentPart } from "../core/types.js";
import { contentToString as baseContentToString } from "../message/modality.js";
import type { StoredEvent } from "../context-window/system-snapshot.js";
import { replaySystemSnapshot } from "../context-window/system-snapshot.js";
import { parseEvents } from "./event-store.js";
import { STREAM_PREFIX } from "../hooks/types.js";

// ─── Rendered node types ─────────────────────────────────────────────────────

export interface TurnNode {
  kind: "turn";
  role: "user" | "agent" | "system";
  seq: number;
  ts: number;
  agent?: string;
  meta: TurnMeta;
  segments: Segment[];
  durationMs?: number;
}

export interface TurnMeta {
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  model?: string;
  /** Percentage of input tokens served from cache (e.g. "95.3%").
   *  Computed from provider sidecar usage_raw — formula varies per provider:
   *    - Anthropic: cache_read / (input + cache_create + cache_read)
   *    - OpenAI:    prompt_tokens_details.cached_tokens / prompt_tokens
   *    - Gemini:    cachedContentTokenCount / promptTokenCount
   *  Replaces raw cacheRead/cacheCreate token counts — ratio is the only
   *  metric that's comparable across providers and turns. */
  cachedRatio?: string;
}

export interface CompactNode {
  kind: "compact";
  seqRange: string;
  summary: string;
  contextPins: string[];
  /** Turn nodes that were compacted — rendered collapsed inside <compact>. */
  wrappedTurns?: TurnNode[];
  /** Nested partial segments inside a complete compact. */
  partials?: PartialCompactNode[];
}

export interface PartialCompactNode {
  kind: "partial_compact";
  seq: number;
  segmentId: string;
  summary: string;
  wrappedTurns?: TurnNode[];
}

export type LedgerNode = TurnNode | CompactNode | PartialCompactNode;

// ─── Segment: atomic content unit within a Turn ──────────────────────────────

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; tool: string; args: Record<string, unknown>; visual_display?: string }
  | { kind: "tool_output"; id: string; tool: string; durationMs: number; output: string; visual_display?: string }
  | { kind: "system_note"; text: string }
  | { kind: "agent_message"; from: string; text: string }
  | { kind: "error"; text: string };

// ─── Event type classification ───────────────────────────────────────────────

const SKIP_TYPES = new Set([
  "hook:toolCall:pending",
  "hook:systemPrompt",
]);

// ─── events.jsonl → LedgerNode[] pipeline ────────────────────────────────────

/** `viewerId` is the agent whose ledger this is; stamps `turn.agent` on every reconstructed turn. */
export function eventsToNodes(events: StoredEvent[], viewerId?: string): LedgerNode[] {
  const nodes: LedgerNode[] = [];
  let turnSeq = 0;
  let compactSeq = 0;

  // Phase 1: collect _msg_* seed messages into a compact node (if any)
  const seeds: StoredEvent[] = [];
  let dataStart = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type.startsWith("_msg_")) {
      seeds.push(events[i]);
      dataStart = i + 1;
    } else {
      break;
    }
  }
  if (seeds.length > 0) {
    const summary = buildCompactSummary(seeds);
    nodes.push({
      kind: "compact",
      seqRange: `0-${compactSeq++}`,
      summary,
      contextPins: [],
    });
  }

  // Phase 2: group events into turns, wrapping at compact_boundary / partial_boundary
  const remaining = events.slice(dataStart).filter(
    e => !e.type.startsWith("_") && !e.type.startsWith(STREAM_PREFIX)
  );

  let currentTurn: TurnNode | null = null;
  let pendingTurns: TurnNode[] = [];
  let pendingPartials: PartialCompactNode[] = [];
  let partialSeq = 0;

  for (const ev of remaining) {
    if (SKIP_TYPES.has(ev.type)) continue;

    // partial_boundary: collect covered turns into a PartialCompactNode
    if (ev.type === "partial_boundary") {
      if (currentTurn) {
        pendingTurns.push(currentTurn);
        currentTurn = null;
      }
      const p = ev.payload ?? {};
      const protectionCutoff = (p.summarizedRange as { toTs?: number })?.toTs ?? 0;
      const summary = ((p.summary as string) ?? "").trim()
        || `[partial compact segment]`;
      const segmentId = (p.segmentId as string) ?? "";

      // Split pendingTurns: turns before the protection cutoff go into wrappedTurns
      const wrappedTurns: TurnNode[] = [];
      const keptTurns: TurnNode[] = [];
      for (const turn of pendingTurns) {
        if (protectionCutoff > 0 && turn.ts < protectionCutoff) {
          wrappedTurns.push(turn);
        } else {
          keptTurns.push(turn);
        }
      }
      pendingTurns = keptTurns;

      pendingPartials.push({
        kind: "partial_compact",
        seq: partialSeq++,
        segmentId,
        summary,
        wrappedTurns: wrappedTurns.length > 0 ? wrappedTurns : undefined,
      });
      turnSeq = 0;
      continue;
    }

    // compact_boundary: gather pendingPartials + split pendingTurns
    if (ev.type === "compact_boundary") {
      if (currentTurn) {
        pendingTurns.push(currentTurn);
        currentTurn = null;
      }
      const keepCount = Math.max(0, (ev.payload?.keepCount as number) ?? 0);
      const splitAt = findKeepSplitByMessageCount(pendingTurns, keepCount);
      const compactedTurns = pendingTurns.slice(0, splitAt);
      const keptTurns = pendingTurns.slice(splitAt);

      const summary = ((ev.payload?.summary as string) ?? "").trim()
        || `[compacted ${compactedTurns.length} turns]`;
      nodes.push({
        kind: "compact",
        seqRange: `${compactSeq}-${compactSeq + compactedTurns.length}`,
        summary,
        contextPins: [],
        wrappedTurns: compactedTurns.length > 0 ? compactedTurns : undefined,
        partials: pendingPartials.length > 0 ? [...pendingPartials] : undefined,
      });
      compactSeq += compactedTurns.length + 1;
      turnSeq = 0;
      pendingTurns = [...keptTurns];
      pendingPartials = [];
      continue;
    }

    if (ev.type === "hook:turnStart") {
      if (currentTurn) {
        pendingTurns.push(currentTurn);
      }
      currentTurn = {
        kind: "turn",
        role: "agent",
        seq: turnSeq++,
        ts: ev.ts,
        agent: viewerId,
        meta: {},
        segments: [],
      };
      continue;
    }

    if (ev.type === "hook:turnEnd") {
      if (currentTurn) {
        currentTurn.durationMs = ev.ts - currentTurn.ts;
        pendingTurns.push(currentTurn);
        currentTurn = null;
      }
      continue;
    }

    const role = classifyRole(ev);
    if (!role) continue;

    if (!currentTurn) {
      currentTurn = {
        kind: "turn",
        role,
        seq: turnSeq++,
        ts: ev.ts,
        agent: viewerId,
        meta: {},
        segments: [],
      };
    }

    const segments = eventToSegments(ev);
    currentTurn.segments.push(...segments);

    const meta = extractMeta(ev);
    if (meta) Object.assign(currentTurn.meta, meta);
  }

  if (currentTurn) pendingTurns.push(currentTurn);
  // Remaining partials (no compact_boundary wrapping them) → top-level nodes
  if (pendingPartials.length > 0) {
    nodes.push(...pendingPartials);
    pendingPartials = [];
  }
  // Remaining turns after the last boundary (protection zone)
  nodes.push(...pendingTurns);
  return nodes;
}

// ─── Role classification ─────────────────────────────────────────────────────

function classifyRole(ev: StoredEvent): "user" | "agent" | "system" | null {
  switch (ev.type) {
    case "user_input":
      return "user";
    case "hook:assistantMessage":
    case "hook:toolCall":
    case "hook:toolResult":
      return "agent";
    case "agent_command":
    case "error":
      return "system";
    case "message":
      return "agent";
    default:
      if (ev.type.startsWith("hook:")) return null;
      return "system";
  }
}

// ─── Event → Segment conversion ─────────────────────────────────────────────

function eventToSegments(ev: StoredEvent): Segment[] {
  const p = ev.payload ?? {};
  const segments: Segment[] = [];

  switch (ev.type) {
    case "user_input": {
      const text = extractDisplayText(p);
      if (text) segments.push({ kind: "text", text });
      break;
    }
    case "hook:assistantMessage": {
      const msg = extractLLMMessage(p);
      if (msg?.thinking) {
        segments.push({ kind: "thinking", text: msg.thinking });
      }
      const text = msg ? contentToString(msg.content) : extractDisplayText(p);
      if (text) segments.push({ kind: "text", text });
      break;
    }
    case "hook:toolCall": {
      const id = (p.id ?? "") as string;
      const tool = (p.name ?? "") as string;
      const args = (p.args ?? {}) as Record<string, unknown>;
      const vis = p.visual_display ? stripAnsi(String(p.visual_display)) : undefined;
      segments.push({ kind: "tool_call", id, tool, args, visual_display: vis });
      break;
    }
    case "hook:toolResult": {
      const id = (p.id ?? "") as string;
      const tool = (p.name ?? "") as string;
      const durationMs = (p.durationMs ?? 0) as number;
      const vis = p.visual_display ? stripAnsi(String(p.visual_display)) : undefined;
      const msg = extractLLMMessage(p);
      const output = vis ?? (msg ? contentToString(msg.content) : "") ?? "";
      segments.push({ kind: "tool_output", id, tool, durationMs, output, visual_display: vis });
      break;
    }
    case "agent_command": {
      const toolName = (p.toolName ?? p.tool ?? "") as string;
      segments.push({ kind: "system_note", text: `/${toolName}` });
      break;
    }
    case "message": {
      const text = extractDisplayText(p);
      if (text) {
        const from = (typeof ev.emitterId === "string" && ev.emitterId) ? ev.emitterId : (ev.source ?? "?");
        segments.push({ kind: "agent_message", from, text });
      }
      break;
    }
    case "error": {
      const raw = p.visual_display ? stripAnsi(String(p.visual_display)) : (p.text as string) ?? extractDisplayText(p);
      if (raw) segments.push({ kind: "error", text: raw });
      break;
    }
    default: {
      const text = extractDisplayText(p);
      if (text) segments.push({ kind: "text", text });
    }
  }
  return segments;
}

// ─── XML serialization ──────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function optAttr(key: string, val: string | number | undefined): string {
  return val !== undefined ? ` ${key}="${esc(String(val))}"` : "";
}

function segmentToXML(seg: Segment): string {
  switch (seg.kind) {
    case "text":
      return `  ${esc(seg.text)}`;
    case "thinking":
      return `  <thinking>${esc(seg.text)}</thinking>`;
    case "tool_call": {
      const vis = seg.visual_display;
      if (vis) {
        return `  <tool_call id="${esc(seg.id)}" tool="${esc(seg.tool)}">${esc(vis)}</tool_call>`;
      }
      return `  <tool_call id="${esc(seg.id)}" tool="${esc(seg.tool)}">\n    <args>${esc(JSON.stringify(seg.args))}</args>\n  </tool_call>`;
    }
    case "tool_output": {
      const display = seg.visual_display ?? truncate(seg.output, 500);
      return `  <tool_output id="${esc(seg.id)}" tool="${esc(seg.tool)}" duration="${seg.durationMs}ms">${esc(display)}</tool_output>`;
    }
    case "system_note":
      return `  <system_note>${esc(seg.text)}</system_note>`;
    case "agent_message":
      return `  <agent_message from="${esc(seg.from)}">${esc(seg.text)}</agent_message>`;
    case "error":
      return `  <error>${esc(seg.text)}</error>`;
  }
}

function turnToXML(turn: TurnNode): string {
  const m = turn.meta;
  const metaAttrs = [
    optAttr("tokensIn", m.tokensIn),
    optAttr("tokensOut", m.tokensOut),
    optAttr("latencyMs", m.latencyMs),
    optAttr("model", m.model),
    optAttr("cachedRatio", m.cachedRatio),
  ].join("");

  const head = `<turn role="${turn.role}" seq="${turn.seq}" ts="${turn.ts}"${optAttr("agent", turn.agent)}${optAttr("durationMs", turn.durationMs)}${metaAttrs}>`;
  const body = turn.segments.map(segmentToXML).join("\n");
  return `${head}\n${body}\n</turn>`;
}

function compactToXML(node: CompactNode): string {
  const parts: string[] = [];
  parts.push(`  <summary>${esc(node.summary)}</summary>`);
  if (node.contextPins.length > 0) {
    for (const p of node.contextPins) {
      parts.push(`  <context_pin>${esc(p)}</context_pin>`);
    }
  }
  if (node.partials && node.partials.length > 0) {
    for (const partial of node.partials) {
      const inner = partialCompactToXML(partial).split("\n").map(l => "  " + l).join("\n");
      parts.push(inner);
    }
  }
  if (node.wrappedTurns && node.wrappedTurns.length > 0) {
    parts.push(`  <collapsed count="${node.wrappedTurns.length}">`);
    for (const turn of node.wrappedTurns) {
      const inner = turnToXML(turn).split("\n").map(l => "    " + l).join("\n");
      parts.push(inner);
    }
    parts.push(`  </collapsed>`);
  }
  return `<compact seq="${esc(node.seqRange)}">\n${parts.join("\n")}\n</compact>`;
}

function partialCompactToXML(node: PartialCompactNode): string {
  const parts: string[] = [];
  parts.push(`  <summary>${esc(node.summary)}</summary>`);
  if (node.wrappedTurns && node.wrappedTurns.length > 0) {
    parts.push(`  <collapsed count="${node.wrappedTurns.length}">`);
    for (const turn of node.wrappedTurns) {
      const inner = turnToXML(turn).split("\n").map(l => "    " + l).join("\n");
      parts.push(inner);
    }
    parts.push(`  </collapsed>`);
  }
  return `<partial_compact seq="${node.seq}"${optAttr("segment_id", node.segmentId)}>\n${parts.join("\n")}\n</partial_compact>`;
}

function nodeToXML(node: LedgerNode): string {
  switch (node.kind) {
    case "turn": return turnToXML(node);
    case "compact": return compactToXML(node);
    case "partial_compact": return partialCompactToXML(node);
  }
}

interface SystemSlotView {
  name: string;
  text: string;
  priority: number;
  cacheHint?: "stable" | "dynamic";
}

function indentBlock(text: string, indent: string): string {
  return text.split("\n").map(line => line ? indent + line : "").join("\n");
}

function renderSystemBlock(slots: SystemSlotView[]): string {
  if (slots.length === 0) return "";

  let lastHint: "stable" | "dynamic" | undefined;
  const parts: string[] = [];

  for (const slot of slots) {
    // After v3 priority namespace split, dynamic slots also use 0..99 — we
    // can no longer infer cacheHint from priority. Use the explicit hint
    // replayed from the source SystemBlock; default to "dynamic" (matches
    // prompt-pipeline.ts:resolveCacheHint default) for legacy snapshots.
    const hint: "stable" | "dynamic" = slot.cacheHint ?? "dynamic";

    if (hint !== lastHint) {
      if (lastHint === "stable" && hint === "dynamic") {
        parts.push(`  <!-- ═══ cache breakpoint ═══ -->\n`);
      }
      parts.push(`  <!-- ─── ${hint} section ─── -->`);
      lastHint = hint;
    }

    // COMPAT: pre-xmlWrap events may not have automatic <slotName> wrapping
    const innerText = slot.text.startsWith(`<${slot.name}`)
      ? slot.text
      : `<${slot.name}>\n${slot.text}\n</${slot.name}>`;

    parts.push(indentBlock(innerText, "  "));
  }

  return `<system>\n${parts.join("\n\n")}\n</system>`;
}

export function toXML(nodes: readonly LedgerNode[], agentId?: string, sessionId?: string, systemSlots?: SystemSlotView[]): string {
  const rootAttrs = [
    optAttr("agent", agentId),
    optAttr("session", sessionId),
  ].join("");

  const systemBlock = systemSlots && systemSlots.length > 0
    ? renderSystemBlock(systemSlots) + "\n\n"
    : "";

  const body = nodes.map(nodeToXML).join("\n\n");
  return `<ledger${rootAttrs}>\n\n${systemBlock}${body}\n\n</ledger>\n`;
}

/**
 * Full pipeline: raw JSONL string → XML string.
 */
export function jsonlToXML(raw: string, agentId?: string, sessionId?: string): string {
  const events = parseEvents(raw);
  const snapshotMap = replaySystemSnapshot(events);
  const slots: SystemSlotView[] = [...snapshotMap.entries()]
    .filter(([, e]) => e.text)
    .map(([name, e]) => ({ name, text: e.text, priority: e.priority, cacheHint: e.cacheHint }))
    // Mirror prompt-pipeline.ts:sortSlots — group by cacheHint first (stable
    // before dynamic), then priority asc within each group. Required after
    // namespace split since stable and dynamic now share the 0..99 range.
    .sort((a, b) => {
      const ha = a.cacheHint ?? "dynamic";
      const hb = b.cacheHint ?? "dynamic";
      if (ha !== hb) return ha === "stable" ? -1 : 1;
      return a.priority - b.priority;
    });
  const nodes = eventsToNodes(events, agentId);
  return toXML(nodes, agentId, sessionId, slots.length > 0 ? slots : undefined);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractLLMMessage(p: Record<string, unknown>): LLMMessage | null {
  const raw = p.llmMessage;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return (raw as LLMMessage[])[0] ?? null;
  return raw as LLMMessage;
}

function contentToString(content: ContentPart[] | string | undefined | null): string | null {
  if (content == null) return null;
  return baseContentToString(typeof content === "string" ? content : content) || null;
}

function extractDisplayText(p: Record<string, unknown>): string | null {
  if (p.visual_display && typeof p.visual_display === "string") return stripAnsi(p.visual_display);
  const c = p.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return contentToString(c as ContentPart[]);
  return null;
}

function extractMeta(ev: StoredEvent): TurnMeta | null {
  const payload = ev.payload ?? {};
  const msg = extractLLMMessage(payload);
  if (!msg) return null;
  const meta: TurnMeta = {};
  const usage = payload.usage as { inputTokens: number; outputTokens: number } | undefined;
  if (usage) {
    meta.tokensIn = usage.inputTokens;
    meta.tokensOut = usage.outputTokens;
  }
  const model = payload.model as string | undefined;
  if (model) meta.model = model;
  const sidecar = payload.providerSidecarData as LLMMessage["providerSidecarData"] | undefined;
  if (sidecar) {
    // After !222 v2 ("provider sidecar full-passthrough"), each provider's
    // sidecar carries the raw API usage object verbatim under `.usage_raw` rather
    // than enumerated camelCase fields. (Field name `usage_raw` chosen to avoid
    // collision with framework outer `usage: { inputTokens, outputTokens }`.)
    // Compute cachedRatio (cache hit %) per provider — absolute token counts
    // hidden from ledger; ratio is the only cross-provider, cross-turn comparable
    // metric. Format: "XX.X%" (one decimal). Skip when total input is 0.
    const anthropic = sidecar.anthropic as Record<string, unknown> | undefined;
    const anthropicUsage = anthropic?.usage_raw as Record<string, unknown> | undefined;
    if (anthropicUsage) {
      const naked = typeof anthropicUsage.input_tokens === "number" ? anthropicUsage.input_tokens : 0;
      const cacheRead = typeof anthropicUsage.cache_read_input_tokens === "number" ? anthropicUsage.cache_read_input_tokens : 0;
      const cacheCreate = typeof anthropicUsage.cache_creation_input_tokens === "number" ? anthropicUsage.cache_creation_input_tokens : 0;
      const total = naked + cacheRead + cacheCreate;
      if (total > 0) meta.cachedRatio = `${(cacheRead / total * 100).toFixed(1)}%`;
    }
    const openai = sidecar.openai as Record<string, unknown> | undefined;
    const openaiUsage = openai?.usage_raw as Record<string, unknown> | undefined;
    const openaiPromptDetails = openaiUsage?.prompt_tokens_details as
      | Record<string, unknown>
      | undefined;
    if (openaiUsage && typeof openaiUsage.prompt_tokens === "number") {
      const promptTotal = openaiUsage.prompt_tokens;
      const cached = typeof openaiPromptDetails?.cached_tokens === "number" ? openaiPromptDetails.cached_tokens : 0;
      if (promptTotal > 0) meta.cachedRatio = `${(cached / promptTotal * 100).toFixed(1)}%`;
    }
    // OpenAI Responses uses different usage field names than chat-completions
    // (input_tokens vs prompt_tokens). Top-level sidecar key is also separate
    // (`openai_response`, not `openai`) to avoid the chat-completions branch
    // above silently matching with the wrong formula.
    const openaiResp = sidecar.openai_response as Record<string, unknown> | undefined;
    const openaiRespUsage = openaiResp?.usage_raw as Record<string, unknown> | undefined;
    const openaiRespInputDetails = openaiRespUsage?.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    if (openaiRespUsage && typeof openaiRespUsage.input_tokens === "number") {
      const inputTotal = openaiRespUsage.input_tokens;
      const cached = typeof openaiRespInputDetails?.cached_tokens === "number" ? openaiRespInputDetails.cached_tokens : 0;
      if (inputTotal > 0) meta.cachedRatio = `${(cached / inputTotal * 100).toFixed(1)}%`;
    }
    const google = sidecar.google as Record<string, unknown> | undefined;
    const googleUsage = google?.usage_raw as Record<string, unknown> | undefined;
    if (googleUsage && typeof googleUsage.promptTokenCount === "number") {
      const promptTotal = googleUsage.promptTokenCount;
      const cached = typeof googleUsage.cachedContentTokenCount === "number" ? googleUsage.cachedContentTokenCount : 0;
      if (promptTotal > 0) meta.cachedRatio = `${(cached / promptTotal * 100).toFixed(1)}%`;
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Count LLM-message-bearing segments in a turn.
 * Mirrors context-window's counting of events with `payload.llmMessage`:
 * text (from assistantMessage/user_input), tool_call, and tool_output each map to one llmMessage.
 */
function countMessagesInTurn(turn: TurnNode): number {
  let n = 0;
  for (const seg of turn.segments) {
    if (seg.kind === "text" || seg.kind === "tool_call" || seg.kind === "tool_output") n++;
  }
  return Math.max(1, n);
}

/**
 * Walk pendingTurns backwards, accumulating message counts until we reach
 * keepCount messages. Returns the split index: turns[0..splitAt) are compacted,
 * turns[splitAt..) are kept.
 */
function findKeepSplitByMessageCount(turns: TurnNode[], keepCount: number): number {
  if (keepCount <= 0) return turns.length;
  let remaining = keepCount;
  for (let i = turns.length - 1; i >= 0; i--) {
    remaining -= countMessagesInTurn(turns[i]);
    if (remaining <= 0) return i;
  }
  return 0;
}

function buildCompactSummary(seeds: StoredEvent[]): string {
  const roles = new Map<string, number>();
  for (const s of seeds) {
    const role = s.type.replace("_msg_", "");
    roles.set(role, (roles.get(role) ?? 0) + 1);
  }
  const parts = [...roles.entries()].map(([r, n]) => `${n} ${r}`);
  return `[compacted session: ${parts.join(", ")}]`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
