/**
 * cursor-mapper 单测 —— 验证 cursor-agent ndjson → 中立 KernelEvent 的映射。
 * main 未随 cursor-agent provider 附带单测;移植成 kernel 时补上,锁住最易错的
 * 三处:assistant 文本去重、tool_call envelope 解析、result → turn.usage 先于
 * turn.done 的不变量。
 */
import { describe, expect, test } from 'bun:test';
import {
  createCursorMapperState,
  flushCursorMapper,
  mapCursorEvent,
  type CursorRawEvent,
} from '../src/kernel/cursor-mapper';

function run(raws: CursorRawEvent[]) {
  const state = createCursorMapperState();
  const out = [];
  for (const r of raws) out.push(...mapCursorEvent(r, state));
  return { out, state };
}

describe('cursor-mapper', () => {
  test('records cursor session_id from system.init', () => {
    const { state } = run([{ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'x' } as CursorRawEvent]);
    expect(state.sessionId).toBe('abc-123');
  });

  test('assistant dedupe: only streaming deltas (timestamp_ms, no model_call_id) emit', () => {
    const { out } = run([
      // streaming delta → emit
      { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'Hel' }] } },
      // streaming delta → emit
      { type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: 'lo' }] } },
      // per-call snapshot (has model_call_id) → drop
      { type: 'assistant', model_call_id: 'c1', message: { content: [{ type: 'text', text: 'Hello' }] } },
      // final snapshot (no timestamp_ms, no model_call_id) → drop
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    ] as CursorRawEvent[]);
    const deltas = out.filter((e) => e.kind === 'message.delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d: any) => d.text).join('')).toBe('Hello');
  });

  test('thinking delta → thinking.delta', () => {
    const { out } = run([{ type: 'thinking', subtype: 'delta', text: 'hmm' } as CursorRawEvent]);
    expect(out).toEqual([{ kind: 'thinking.delta', text: 'hmm' }]);
  });

  test('tool_call started → tool.call with display name + args', () => {
    const { out } = run([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc1',
        tool_call: { shellToolCall: { args: { command: 'ls' } } },
      } as CursorRawEvent,
    ]);
    expect(out).toEqual([{ kind: 'tool.call', callId: 'tc1', name: 'Bash', args: { command: 'ls' } }]);
  });

  test('tool_call completed success → tool.result ok with stdout', () => {
    const { out } = run([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc1',
        tool_call: { shellToolCall: { result: { success: { stdout: 'file.txt' } } } },
      } as CursorRawEvent,
    ]);
    expect(out).toEqual([{ kind: 'tool.result', callId: 'tc1', ok: true, result: 'file.txt' }]);
  });

  test('tool_call completed rejected → tool.result not ok with reason', () => {
    const { out } = run([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc2',
        tool_call: { editToolCall: { result: { rejected: { reason: 'denied' } } } },
      } as CursorRawEvent,
    ]);
    expect(out).toEqual([{ kind: 'tool.result', callId: 'tc2', ok: false, error: 'denied' }]);
  });

  test('result success → turn.usage BEFORE turn.done(stop), with token usage', () => {
    const { out, state } = run([
      // normal case: text already streamed → result must NOT re-emit it as a fallback delta.
      { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'done' }] } },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        duration_ms: 1234,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
      },
    ] as CursorRawEvent[]);
    // 1 streamed delta + turn.usage + turn.done — no duplicate fallback delta.
    expect(out.map((e) => e.kind)).toEqual(['message.delta', 'turn.usage', 'turn.done']);
    expect(out[1]).toEqual({ kind: 'turn.usage', inputTokens: 10, outputTokens: 20, cacheRead: 5, durationMs: 1234 });
    expect(out[2]).toEqual({ kind: 'turn.done', reason: 'stop' });
    expect(state.doneEmitted).toBe(true);
  });

  test('result fallback: zero streamed deltas → result.result becomes one message.delta', () => {
    // cursor 短/快回答偶尔只发「最终快照」(无 timestamp_ms,被去重丢弃)→ 全程零 delta;
    // 此时拿 result.result 兜底,回答不被静默吞掉。
    const { out } = run([
      // final snapshot only (no timestamp_ms) → dropped by dedupe
      { type: 'assistant', message: { content: [{ type: 'text', text: '42' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '42' },
    ] as CursorRawEvent[]);
    expect(out.map((e) => e.kind)).toEqual(['message.delta', 'turn.usage', 'turn.done']);
    expect(out[0]).toEqual({ kind: 'message.delta', role: 'assistant', text: '42' });
  });

  test('result fallback does NOT fire on error subtype (only success path)', () => {
    const { out } = run([
      { type: 'result', subtype: 'error', is_error: true, result: 'boom' },
    ] as CursorRawEvent[]);
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
  });

  test('result error → turn.usage, error, turn.done(error)', () => {
    const { out } = run([
      { type: 'result', subtype: 'error', is_error: true, result: 'boom' } as CursorRawEvent,
    ]);
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect((out[1] as any).error.message).toBe('boom');
    expect((out[2] as any).reason).toBe('error');
  });

  test('events after done are ignored', () => {
    const state = createCursorMapperState();
    mapCursorEvent({ type: 'result', subtype: 'success' } as CursorRawEvent, state);
    const after = mapCursorEvent(
      { type: 'assistant', timestamp_ms: 9, message: { content: [{ type: 'text', text: 'late' }] } } as CursorRawEvent,
      state,
    );
    expect(after).toHaveLength(0);
  });

  test('flush emits a terminal turn when stream ended without result', () => {
    const state = createCursorMapperState();
    expect(flushCursorMapper(state).map((e) => e.kind)).toEqual(['turn.usage', 'turn.done']);
    // idempotent once done
    expect(flushCursorMapper(state)).toHaveLength(0);
  });
});
