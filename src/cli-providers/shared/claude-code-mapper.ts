// Stateful translator: one the reference agent CLI ndjson event → 0..N ChatEvents.
// Schema captured under /tmp/cli-providers-cron-state.json phases.2.research.
// Streaming flow:
//   system.init                                  → ignore (just records session_id)
//   stream_event.message_start                   → ignore
//   stream_event.content_block_start (tool_use)  → buffer {id, name, partialArgs}
//   stream_event.content_block_delta text_delta  → ChatEvent token
//   stream_event.content_block_delta thinking    → ChatEvent thinking
//   stream_event.content_block_delta input_json  → append to tool-call buffer
//   stream_event.content_block_stop              → flush tool-call buffer if any
//   stream_event.message_stop                    → ignore (use `result` instead)
//   assistant                                    → ignore (duplicate snapshot)
//   result subtype=success                       → ChatEvent done
//   result is_error                              → ChatEvent error

import type { ChatEvent } from '../types';

type ToolUseBuffer = { id: string; name: string; partialArgs: string };

interface RawDelta {
  type: 'text_delta' | 'input_json_delta' | 'thinking_delta';
  text?: string;
  partial_json?: string;
  thinking?: string;
}

interface RawContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  id?: string;
  name?: string;
}

/** A tool_result block as CC ships it inside a `type:"user"` event after the
 *  subprocess (or a subagent) finishes a tool. `content` is a plain string for
 *  Bash/Write/Edit, or an array of content blocks (text/image) for richer
 *  tools (e.g. the subagent return). `is_error:true` is how CC reports a
 *  permission denial ("…haven't granted it yet") or a failed tool. */
interface RawToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUserEvent {
  type: 'user';
  message?: { role?: string; content?: unknown[] };
}

interface RawStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  index?: number;
  content_block?: RawContentBlock;
  delta?: RawDelta | { stop_reason?: string };
}

interface RawSystemEvent {
  type: 'system';
  subtype?: 'init' | 'status' | string;
  session_id?: string;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawResultEvent {
  type: 'result';
  subtype?: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: RawUsage;
}

interface RawAssistantOrOther {
  type: 'assistant' | 'stream_event' | string;
  event?: RawStreamEvent;
  session_id?: string;
  message?: { usage?: RawUsage };
}

export type ClaudeRawEvent = (
  | RawSystemEvent
  | RawResultEvent
  | RawUserEvent
  | RawAssistantOrOther
) & {
  [k: string]: unknown;
};

/** Flatten a tool_result `content` (string | content-block[]) to a string for
 *  the UI. Non-text blocks (images) collapse to empty and are dropped. */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export interface MappedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ClaudeMapperState {
  sessionId?: string;
  toolUseByIndex: Map<number, ToolUseBuffer>;
  /** Set once result/message_stop emits done — guards against double-emit. */
  doneEmitted: boolean;
  /** Latest usage snapshot from assistant message_start / message_delta /
   *  assistant snapshot / final result. Threaded into the terminal `done`
   *  event so the observatory turn node can render `📥inputTokens · 📤outputTokens`. */
  lastUsage?: MappedUsage;
}

export function createClaudeMapperState(): ClaudeMapperState {
  return {
    sessionId: undefined,
    toolUseByIndex: new Map(),
    doneEmitted: false,
    lastUsage: undefined,
  };
}

/** Pull a normalized MappedUsage off any raw object that might carry one,
 *  preferring fields actually present (so partial snapshots don't clobber a
 *  prior fuller snapshot). Mutates `state.lastUsage`. */
function captureUsage(state: ClaudeMapperState, raw: RawUsage | undefined): void {
  if (!raw) return;
  const cur: MappedUsage = state.lastUsage ?? {};
  if (typeof raw.input_tokens === 'number') cur.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') cur.outputTokens = raw.output_tokens;
  if (typeof raw.cache_read_input_tokens === 'number') cur.cacheReadTokens = raw.cache_read_input_tokens;
  if (typeof raw.cache_creation_input_tokens === 'number') cur.cacheCreationTokens = raw.cache_creation_input_tokens;
  state.lastUsage = cur;
}

function mapStopReason(r: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' {
  switch (r) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
    case 'end_turn':
    default:
      return 'end_turn';
  }
}

/** Translate one raw ndjson event. Mutates `state`. Returns 0..N ChatEvents. */
export function mapClaudeEvent(raw: ClaudeRawEvent, state: ClaudeMapperState): ChatEvent[] {
  const out: ChatEvent[] = [];

  // Capture session_id off any event that carries it (init is the typical
  // first carrier; downstream events repeat it).
  if (typeof raw.session_id === 'string' && !state.sessionId) {
    state.sessionId = raw.session_id;
  }

  // After the turn-final `result` event, any straggling stream_event.* (cancel
  // paths can ship a late content_block_delta after result) must not leak
  // tokens or tool-calls into a settled-done bubble. The result/result handler
  // already guards against double-done; this catches the other-event-types.
  if (state.doneEmitted) return out;

  // system.init / system.status: handshake noise, ignore.
  if (raw.type === 'system') return out;

  // assistant snapshot: text was already streamed via content_block_delta; we
  // mine the snapshot only for `message.usage` (the cheapest source of
  // input/output/cache token counts) and drop the rest.
  if (raw.type === 'assistant') {
    captureUsage(state, (raw as RawAssistantOrOther).message?.usage);
    return out;
  }

  // result: final per-turn outcome.
  if (raw.type === 'result') {
    const r = raw as RawResultEvent;
    if (state.doneEmitted) return out;
    captureUsage(state, r.usage);
    if (r.is_error || (r.subtype && r.subtype !== 'success')) {
      out.push({
        type: 'error',
        message: r.result || `claude exited with subtype=${r.subtype ?? 'unknown'}`,
      });
    } else {
      out.push({
        type: 'done',
        stopReason: mapStopReason(r.stop_reason),
        ...(typeof r.total_cost_usd === 'number' ? { cost: r.total_cost_usd } : {}),
        ...(typeof r.duration_ms === 'number' ? { durationMs: r.duration_ms } : {}),
        ...(state.lastUsage ? { usage: { ...state.lastUsage } } : {}),
      });
    }
    state.doneEmitted = true;
    return out;
  }

  // user: the tool_result carrier. Emitted after the subprocess (or a
  // subagent) runs a tool — Bash/Write/Edit output, a subagent's return, OR a
  // permission denial (`is_error:true`). Previously this whole event type was
  // dropped, so the tool-call chip never received a `tool-result` and stayed
  // stuck `running` forever, and permission denials were completely invisible.
  // Map each tool_result block → a `tool-result` ChatEvent keyed by
  // tool_use_id (== the callId the tool-call chip was created with).
  if (raw.type === 'user') {
    const content = (raw as RawUserEvent).message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result') {
          const tr = block as RawToolResultBlock;
          const text = flattenToolResultContent(tr.content);
          const isErr = tr.is_error === true;
          out.push({
            type: 'tool-result',
            callId: tr.tool_use_id ?? '',
            ok: !isErr,
            ...(isErr ? { error: text } : { result: text }),
          });
        }
      }
    }
    return out;
  }

  // stream_event payload.
  if (raw.type === 'stream_event' && (raw as RawAssistantOrOther).event) {
    const ev = (raw as RawAssistantOrOther).event as RawStreamEvent;

    switch (ev.type) {
      case 'message_start':
        return out;

      case 'content_block_start': {
        const block = ev.content_block;
        if (block?.type === 'tool_use' && typeof ev.index === 'number') {
          state.toolUseByIndex.set(ev.index, {
            id: block.id ?? '',
            name: block.name ?? '',
            partialArgs: '',
          });
        }
        return out;
      }

      case 'content_block_delta': {
        const d = ev.delta as RawDelta | undefined;
        if (!d) return out;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          out.push({ type: 'token', text: d.text });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          out.push({ type: 'thinking', text: d.thinking });
        } else if (d.type === 'thinking_delta' && typeof d.text === 'string') {
          // Some SDK versions put thinking text under `text` instead of `thinking`.
          out.push({ type: 'thinking', text: d.text });
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const buf = typeof ev.index === 'number' ? state.toolUseByIndex.get(ev.index) : undefined;
          if (buf) {
            buf.partialArgs += d.partial_json;
            out.push({ type: 'tool-call-delta', callId: buf.id, name: buf.name, argumentsDelta: d.partial_json });
          }
        }
        return out;
      }

      case 'content_block_stop': {
        if (typeof ev.index === 'number') {
          const buf = state.toolUseByIndex.get(ev.index);
          if (buf) {
            let args: unknown = {};
            try {
              args = buf.partialArgs ? JSON.parse(buf.partialArgs) : {};
            } catch {
              args = { _raw: buf.partialArgs };
            }
            out.push({ type: 'tool-call', name: buf.name, args, callId: buf.id });
            state.toolUseByIndex.delete(ev.index);
          }
        }
        return out;
      }

      case 'message_delta':
      case 'message_stop':
        return out;
    }
  }

  return out;
}

/** Drain a final 'done' if the stream ended without a `result` event
 *  (e.g. the subprocess exited cleanly but we never saw the closing line). */
export function flushClaudeMapper(state: ClaudeMapperState): ChatEvent[] {
  if (state.doneEmitted) return [];
  state.doneEmitted = true;
  return [{ type: 'done', stopReason: 'end_turn' }];
}
