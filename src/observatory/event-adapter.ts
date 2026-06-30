/** Observatory event-shape adapter.
 *
 *  forgeax bus events (StoredEvent) → observatory frontend AgentEvent union.
 *  Pure-ish: holds per-stream state (turn counters, sub-agent depth) but does not
 *  read filesystem or globals. One adapter per SSE connection (live replay
 *  + tail share state); two parallel SSE listeners must each have their own.
 *
 *  Rationale: the observatory frontend expects events shaped like harness's
 *  agentic_os emits — `{type:"llm_call",subtype:"start"|"end"}`,
 *  `tool_use`, `tool_result`, `sub_agent/started|progress|done`,
 *  `text`, `context_update`, `turn_end`. forgeax instead emits hook:* and
 *  stream:* on a per-session bus; the field names match neither the type
 *  nor the payload conventions. Translating once on the server keeps the
 *  observatory frontend agnostic of forgeax internals.
 *
 *  Unmapped event types return `null` and are silently dropped.
 */

import type { StoredEvent } from '../ledger/types';
import { formatCacheHitRatio } from '../lib/cache-ratio';

/** Frontend-facing event shape (subset of harness AgentEvent the UI reads).
 *  Field names match `useEventStream.ts` switch arms exactly. */
export interface AgentEventOut {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface AdaptContext {
  /** Caller-provided session id; threaded into outbound envelopes. */
  sessionId: string;
}

/** State that persists across events on one stream (turn counters, etc). */
interface AdapterState {
  /** monotonically increasing per-agent turn index. Outermost agent uses
   *  emitterId='' or the bootstrap agentPath; we key by emitterId. */
  turnByEmitter: Map<string, number>;
  /** Most recent per-emitter usage from hook:assistantMessage so that
   *  hook:turnEnd can carry it (forgeax splits assistant message tokens
   *  away from the turn-end signal). */
  lastUsageByEmitter: Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>;
  /** turn start timestamps for durationMs at end. */
  turnStartTsByEmitter: Map<string, number>;
  /** Whether we've already emitted the synthetic `system/init` for the stream. */
  initEmitted: boolean;
  /** Open tool calls keyed by tool name → stack of their toolUseIds (LIFO).
   *  Fallback correlation for `hook:toolResult` events that drop the id entirely
   *  (e.g. claude-code MCP `mcp__fxt__*` results arrive as `{name,durationMs}`
   *  with no callId) — without it those nodes never leave "running". */
  openToolIdsByName: Map<string, string[]>;
}

export function createAdapterState(): AdapterState {
  return {
    turnByEmitter: new Map(),
    lastUsageByEmitter: new Map(),
    turnStartTsByEmitter: new Map(),
    initEmitted: false,
    openToolIdsByName: new Map(),
  };
}

/** Synthesise the leading `system/init` event the observatory expects so the
 *  reactflow root node ('session-root') always appears, even when the agent
 *  hasn't yet talked to a model. Caller passes `agentId` (root agent) and
 *  `model` if known. */
export function makeInitEvent(agentId: string, model?: string, persona?: string): AgentEventOut {
  return {
    type: 'system',
    subtype: 'init',
    model: model ?? 'unknown',
    persona: persona ?? agentId,
  };
}

/** One step. Returns 0+ AgentEventOut (some forgeax events explode into
 *  multiple frontend events — e.g. hook:turnEnd → both `llm_call/end` and
 *  `turn_end`). Unknown types return []. */
export function adapt(stored: StoredEvent, state: AdapterState): AgentEventOut[] {
  const emitter = (stored.emitterId ?? '') as string;
  const t = stored.type;

  // ─── user input ────────────────────────────────────────────────────────
  if (t === 'user_input') {
    const text = (stored.payload?.content as string | undefined) ?? (stored.payload?.text as string | undefined) ?? '';
    return [{ type: 'user_message', text }];
  }

  // ─── hook:turnStart → llm_call/start ───────────────────────────────────
  if (t === 'hook:turnStart') {
    const turn = (stored.payload?.turn as number | undefined) ?? incrementTurn(state, emitter);
    state.turnByEmitter.set(emitter, turn);
    state.turnStartTsByEmitter.set(emitter, stored.ts);
    return [{
      type: 'llm_call',
      subtype: 'start',
      model: (stored.payload?.model as string | undefined) ?? 'unknown',
      iteration: turn,
    }];
  }

  // ─── hook:assistantMessage → text + capture usage ──────────────────────
  if (t === 'hook:assistantMessage') {
    const u = stored.payload?.usage as
      | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
      | undefined;
    if (u) {
      state.lastUsageByEmitter.set(emitter, {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadTokens ?? 0,
        cacheCreation: u.cacheCreationTokens ?? 0,
      });
    }
    const msg = (stored.payload?.msg ?? stored.payload?.llmMessage) as { content?: unknown; role?: string } | undefined;
    let content = '';
    if (typeof msg?.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg?.content)) {
      content = (msg!.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n');
    }
    const model = (stored.payload?.model as string | undefined) ?? undefined;
    const out: AgentEventOut[] = [];
    if (content) out.push({ type: 'text', content });
    if (model) out.push({ type: 'model_resolved', model });
    return out;
  }

  // ─── hook:turnEnd → llm_call/end + turn_end ────────────────────────────
  if (t === 'hook:turnEnd') {
    const startTs = state.turnStartTsByEmitter.get(emitter);
    const durationMs = (stored.payload?.durationMs as number | undefined) ?? (startTs ? Math.max(0, stored.ts - startTs) : 0);
    // Prefer usage that ships in the turnEnd payload itself (claude-code
    // bridge fills this from `done.usage`); fall back to the most recent
    // assistant message usage we observed earlier in the turn.
    const inlineUsage = stored.payload?.usage as
      | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
      | undefined;
    const fallback = state.lastUsageByEmitter.get(emitter);
    const usage = inlineUsage ?? (fallback ? {
      inputTokens: fallback.input,
      outputTokens: fallback.output,
      cacheReadTokens: fallback.cacheRead,
      cacheCreationTokens: fallback.cacheCreation,
    } : undefined);
    const u = usage ? {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      // 缓存命中率(还原老 studio 的 cachedRatio,迁移遗失,这里补回 surface)。
      cachedRatio: formatCacheHitRatio(
        usage.inputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheCreationTokens ?? 0,
      ),
    } : undefined;
    const aborted = !!stored.payload?.aborted;
    const stopReason = aborted ? 'cancelled' : 'end_turn';
    return [
      { type: 'llm_call', subtype: 'end', usage: u, durationMs, stopReason },
      { type: 'turn_end', usage: u, durationMs },
    ];
  }

  // ─── hook:toolCall → tool_use ──────────────────────────────────────────
  if (t === 'hook:toolCall') {
    const tc = stored.payload?.toolCall as { id?: string; name?: string } | undefined;
    const toolUseId = tc?.id
      ?? (stored.payload?.toolCallId as string | undefined)
      // forgeax-core carries the correlation id at top-level `callId`
      // (its tool result mirrors it) — read it so call ↔ result line up.
      ?? (stored.payload?.callId as string | undefined)
      ?? `tool-${stored.ts}`;
    const name = (stored.payload?.name as string | undefined) ?? tc?.name ?? 'tool';
    // Track the open call by name so an id-less result can still find it.
    const stack = state.openToolIdsByName.get(name) ?? [];
    stack.push(toolUseId);
    state.openToolIdsByName.set(name, stack);
    return [{
      type: 'tool_use',
      toolUseId,
      name,
      input: stored.payload?.args ?? {},
    }];
  }

  // ─── hook:toolResult → tool_result ─────────────────────────────────────
  if (t === 'hook:toolResult') {
    const resultName = stored.payload?.name as string | undefined;
    let toolUseId = (stored.payload?.toolUseId as string | undefined)
      ?? (stored.payload?.toolCallId as string | undefined)
      // forgeax-core tool result carries the id at top-level `callId` (matches
      // its hook:toolCall) — without this the result resolves to '' and the
      // observatory node never leaves "running" (e.g. ask_user stuck forever).
      ?? (stored.payload?.callId as string | undefined)
      ?? (stored.payload?.llmMessage as { toolCallId?: string } | undefined)?.toolCallId
      ?? '';
    // Last-resort correlation by name: some results drop the id entirely
    // (claude-code MCP `mcp__fxt__*` → `{name,durationMs}`). Pop the most-recent
    // open call of the same name so the node still completes instead of hanging.
    if (!toolUseId && resultName) {
      const stack = state.openToolIdsByName.get(resultName);
      if (stack && stack.length) toolUseId = stack.pop() as string;
    } else if (toolUseId && resultName) {
      // keep the per-name stack tidy when we DO have an id
      const stack = state.openToolIdsByName.get(resultName);
      if (stack) {
        const i = stack.lastIndexOf(toolUseId);
        if (i >= 0) stack.splice(i, 1);
      }
    }
    const llmMsg = stored.payload?.llmMessage as { content?: Array<{ text?: string }>; toolStatus?: string } | undefined;
    const output = (stored.payload?.result as string | undefined)
      ?? (stored.payload?.output as string | undefined)
      ?? (stored.payload?.error as string | undefined)
      ?? (llmMsg?.content?.[0]?.text)
      ?? '';
    const isError = !!stored.payload?.error || llmMsg?.toolStatus === 'failed';
    return [{
      type: 'tool_result',
      toolUseId,
      output,
      isError,
    }];
  }

  // ─── stream:tool_use / stream:tool_result (claude-code bridge path) ────
  if (t === 'stream:tool_use') {
    return [{
      type: 'tool_use',
      toolUseId: (stored.payload?.toolUseId as string | undefined) ?? `tool-${stored.ts}`,
      name: (stored.payload?.name as string | undefined) ?? 'tool',
      input: stored.payload?.input ?? {},
    }];
  }
  if (t === 'stream:tool_result') {
    return [{
      type: 'tool_result',
      toolUseId: (stored.payload?.toolUseId as string | undefined) ?? '',
      output: stored.payload?.output ?? stored.payload?.result ?? '',
      isError: !!stored.payload?.isError,
    }];
  }

  // ─── agent_added / agent_removed (depth>1) → sub_agent/started|done ────
  if (t === 'agent_added') {
    const path = (stored.payload?.path as string | undefined) ?? '';
    if (!path.includes('/')) return [];
    return [{
      type: 'sub_agent',
      subtype: 'started',
      agentId: path,
      agentType: path.split('/').pop() ?? path,
      task: (stored.payload?.task as string | undefined) ?? '',
      persona: (stored.payload?.persona as string | undefined) ?? '',
      identityBlock: (stored.payload?.identityBlock as string | undefined) ?? '',
    }];
  }
  if (t === 'agent_removed') {
    const path = (stored.payload?.path as string | undefined) ?? '';
    if (!path.includes('/')) return [];
    return [{
      type: 'sub_agent',
      subtype: 'done',
      agentId: path,
      status: 'completed',
      result: (stored.payload?.result as string | undefined) ?? '',
    }];
  }

  // ─── partial_boundary / compact_boundary → context_update ─────────────
  if (t === 'partial_boundary' || t === 'compact_boundary') {
    const used = (stored.payload?.usedTokens as number | undefined) ?? 0;
    const limit = (stored.payload?.limit as number | undefined) ?? 0;
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return [{ type: 'context_update', tokens: { used, limit, percent } }];
  }

  return [];
}

function incrementTurn(state: AdapterState, emitter: string): number {
  const next = (state.turnByEmitter.get(emitter) ?? -1) + 1;
  return next;
}
