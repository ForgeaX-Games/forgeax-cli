/**
 * cursor-mapper — cursor-agent `--output-format stream-json --stream-partial-output`
 * 的 ndjson → 中立 `KernelEvent` 的有状态翻译器(一条 raw → 0..N KernelEvent)。
 *
 * 从 server 旧 cli-provider(`shared/cursor-mapper.ts`,产出 ChatEvent)移植而来,
 * 改产中立 KernelEvent —— 与 codex-mapper 并列,所有 cursor-isms 锁在本文件 +
 * cursor-profile.ts 里,`cursor-kernel.ts` 只剩薄脊梁(spine)。
 *
 * cursor 的 wire 不是 claude-code 那套 Anthropic stream_event/content_block_delta,
 * 是 cursor 专属的(schema 现场抓取,cursor-agent 2026.06.15):
 *   {type:"system",subtype:"init",session_id,model}                    → 记 session_id
 *   {type:"user",...}                                                  → 忽略(echo)
 *   {type:"assistant",message:{content:[{type:"text",text}]},timestamp_ms,model_call_id?}
 *                                                                      → message.delta(去重见下)
 *   {type:"thinking",subtype:"delta",text}                            → thinking.delta
 *   {type:"tool_call",subtype:"started",call_id,tool_call:{<x>ToolCall:{args}}}    → tool.call
 *   {type:"tool_call",subtype:"completed",call_id,tool_call:{<x>ToolCall:{result}}} → tool.result
 *   {type:"result",subtype:"success",is_error,result,usage,duration_ms} → turn.usage + turn.done|error
 *
 * ── assistant 文本去重(核心微妙处)──
 * `--stream-partial-output` 下 assistant 文本有三种 flavor:
 *   • 流式 delta        —— 有 `timestamp_ms`,无 `model_call_id`
 *   • per-model-call 快照 —— 有 `model_call_id`(把该 call 的 delta 合并)
 *   • 最终整轮快照       —— 两者都无(完整累积答案)
 * 每个 assistant 事件都发 token 会把整段答案重播 2x。规则(现场验证):仅当
 * `timestamp_ms` 存在 **且** `model_call_id` 缺失 时发 message.delta,丢弃合并快照。
 */
import type { KernelEvent } from '@forgeax/agent-runtime';

interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorRawEvent {
  type: 'system' | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'result' | string;
  subtype?: string;
  session_id?: string;
  // assistant
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  model_call_id?: string;
  timestamp_ms?: number;
  // thinking
  text?: string;
  // tool_call
  call_id?: string;
  tool_call?: Record<string, unknown>;
  // result
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  usage?: RawUsage;
  [k: string]: unknown;
}

interface MappedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface CursorMapperState {
  /** cursor 的 chat session_id(system.init 时记下;= --resume 的 id)。 */
  sessionId?: string;
  doneEmitted: boolean;
  lastUsage?: MappedUsage;
  /** 本轮是否已发过至少一条 assistant `message.delta`。用于 `result` 兜底:cursor
   *  偶尔(短/快回答)不发流式 delta,只发「最终整轮快照」(无 timestamp_ms,被去重
   *  规则丢弃)→ 全程零 delta。此时拿 `result.result`(整轮全文)补一条 delta,
   *  避免回答被静默吞掉。正常情况(已流式发过)则不补,防止整段重播。 */
  emittedText: boolean;
}

export function createCursorMapperState(): CursorMapperState {
  return { sessionId: undefined, doneEmitted: false, lastUsage: undefined, emittedText: false };
}

function captureUsage(state: CursorMapperState, raw: RawUsage | undefined): void {
  if (!raw) return;
  const cur: MappedUsage = state.lastUsage ?? {};
  if (typeof raw.inputTokens === 'number') cur.inputTokens = raw.inputTokens;
  if (typeof raw.outputTokens === 'number') cur.outputTokens = raw.outputTokens;
  if (typeof raw.cacheReadTokens === 'number') cur.cacheRead = raw.cacheReadTokens;
  if (typeof raw.cacheWriteTokens === 'number') cur.cacheCreation = raw.cacheWriteTokens;
  state.lastUsage = cur;
}

/** cursor 的 keyed tool-call 类型(如 "shellToolCall")→ UI 工具 chip 期望的展示名
 *  (Bash/Edit/...);未特判的退回 stripped 前缀的 PascalCase。 */
function toolDisplayName(keyed: string): string {
  const base = keyed.replace(/ToolCall$/, '');
  switch (base) {
    case 'shell':
      return 'Bash';
    case 'edit':
    case 'write':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
    case 'grep':
      return 'Grep';
    case 'mcp':
      return 'mcp';
    default:
      return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'tool';
  }
}

/** tool_call 对象上第一个形如 "<x>ToolCall" 的 envelope key。 */
function keyedToolEnvelope(
  tc: Record<string, unknown> | undefined,
): { keyed: string; body: Record<string, unknown> } | null {
  if (!tc || typeof tc !== 'object') return null;
  for (const k of Object.keys(tc)) {
    if (k.endsWith('ToolCall') && tc[k] && typeof tc[k] === 'object') {
      return { keyed: k, body: tc[k] as Record<string, unknown> };
    }
  }
  return null;
}

/** 把工具结果 `{success:{...}} | {rejected:{...}} | {error:{...}}` 拍平成 { ok, text }。
 *  shell→stdout,edit→message;rejected→reason。 */
function flattenToolResult(result: unknown): { ok: boolean; text: string } {
  if (!result || typeof result !== 'object') return { ok: true, text: '' };
  const r = result as Record<string, any>;
  if (r.success && typeof r.success === 'object') {
    const s = r.success;
    const text =
      (typeof s.stdout === 'string' && s.stdout) || (typeof s.message === 'string' && s.message) || '';
    return { ok: true, text };
  }
  if (r.rejected && typeof r.rejected === 'object') {
    const reason = typeof r.rejected.reason === 'string' ? r.rejected.reason : 'rejected';
    return { ok: false, text: reason || 'rejected' };
  }
  if (r.error) {
    const text = typeof r.error === 'string' ? r.error : (r.error.message ?? 'error');
    return { ok: false, text };
  }
  return { ok: true, text: '' };
}

/** 翻译一条 raw cursor ndjson 事件。Mutates `state`。返回 0..N KernelEvent。 */
export function mapCursorEvent(raw: CursorRawEvent, state: CursorMapperState): KernelEvent[] {
  const out: KernelEvent[] = [];

  if (typeof raw.session_id === 'string' && !state.sessionId) state.sessionId = raw.session_id;
  if (state.doneEmitted) return out;

  switch (raw.type) {
    case 'system':
    case 'user':
      return out;

    case 'assistant': {
      // 去重:只有流式 delta(有 timestamp_ms、无 model_call_id)带新文本;
      // per-call + 最终快照是重复内容。
      if (typeof raw.timestamp_ms !== 'number' || raw.model_call_id) return out;
      const content = raw.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
            out.push({ kind: 'message.delta', role: 'assistant', text: block.text });
            state.emittedText = true;
          }
        }
      }
      return out;
    }

    case 'thinking': {
      if (raw.subtype === 'delta' && typeof raw.text === 'string' && raw.text) {
        out.push({ kind: 'thinking.delta', text: raw.text });
      }
      return out;
    }

    case 'tool_call': {
      const env = keyedToolEnvelope(raw.tool_call);
      const callId = raw.call_id ?? '';
      if (!env || !callId) return out;
      if (raw.subtype === 'started') {
        const args = (env.body.args as unknown) ?? {};
        out.push({ kind: 'tool.call', callId, name: toolDisplayName(env.keyed), args });
      } else if (raw.subtype === 'completed') {
        const { ok, text } = flattenToolResult(env.body.result);
        out.push(
          ok
            ? { kind: 'tool.result', callId, ok: true, result: text }
            : { kind: 'tool.result', callId, ok: false, error: text },
        );
      }
      return out;
    }

    case 'result': {
      captureUsage(state, raw.usage);
      // turn.usage MUST precede turn.done — even on error paths (budget/cascade
      // accounting never drops a turn). Mirrors codex-mapper.
      if (raw.is_error || (raw.subtype && raw.subtype !== 'success')) {
        out.push({ kind: 'turn.usage', ...usageFields(state, raw) });
        out.push({
          kind: 'error',
          error: {
            code: 'protocol',
            message: raw.result || `cursor-agent exited with subtype=${raw.subtype ?? 'unknown'}`,
          },
        });
        out.push({ kind: 'turn.done', reason: 'error' });
      } else {
        // 兜底:全程零流式 delta(短/快回答只有最终快照被去重丢弃)→ 用 result 全文补一条。
        if (!state.emittedText && typeof raw.result === 'string' && raw.result) {
          out.push({ kind: 'message.delta', role: 'assistant', text: raw.result });
          state.emittedText = true;
        }
        out.push({ kind: 'turn.usage', ...usageFields(state, raw) });
        out.push({ kind: 'turn.done', reason: 'stop' });
      }
      state.doneEmitted = true;
      return out;
    }

    default:
      return out; // 容忍未知事件类型
  }
}

function usageFields(
  state: CursorMapperState,
  raw: CursorRawEvent,
): { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheCreation?: number; durationMs?: number } {
  const u = state.lastUsage ?? {};
  return {
    ...(typeof u.inputTokens === 'number' ? { inputTokens: u.inputTokens } : {}),
    ...(typeof u.outputTokens === 'number' ? { outputTokens: u.outputTokens } : {}),
    ...(typeof u.cacheRead === 'number' ? { cacheRead: u.cacheRead } : {}),
    ...(typeof u.cacheCreation === 'number' ? { cacheCreation: u.cacheCreation } : {}),
    ...(typeof raw.duration_ms === 'number' ? { durationMs: raw.duration_ms } : {}),
  };
}

/** 流意外结束(无 result 事件)时补一个终态。 */
export function flushCursorMapper(state: CursorMapperState): KernelEvent[] {
  if (state.doneEmitted) return [];
  state.doneEmitted = true;
  return [{ kind: 'turn.usage' }, { kind: 'turn.done', reason: 'stop' }];
}
