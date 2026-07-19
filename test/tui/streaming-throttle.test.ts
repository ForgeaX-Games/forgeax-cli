/**
 * useStreamingText 的纯函数:extractStreamTextDelta / shouldCommitStream。
 * 只测纯逻辑(节流判定 + delta 抽取);hook 的 timer 编排由真实 TUI e2e 覆盖。
 */
import { test, expect, describe } from 'bun:test';
import { extractStreamTextDelta, extractStreamThinkingDelta, shouldCommitStream, DEFAULT_STREAM_THROTTLE_MS } from '../../src/tui/transcript/useStreamingText';
import type { AgentEvent } from '../../src/tui/contracts';

const streamEv = (delta: unknown): AgentEvent =>
  ({ type: 'stream', event: { type: 'content_block_delta', index: 0, delta } }) as unknown as AgentEvent;

describe('extractStreamTextDelta', () => {
  test('text_delta → returns text', () => {
    expect(extractStreamTextDelta(streamEv({ type: 'text_delta', text: 'hi' }))).toBe('hi');
  });
  test('thinking_delta / partial_json → ""', () => {
    expect(extractStreamTextDelta(streamEv({ type: 'thinking_delta', thinking: 'x' }))).toBe('');
    expect(extractStreamTextDelta(streamEv({ type: 'input_json_delta', partial_json: '{' }))).toBe('');
  });
  test('non-stream / non-content_block_delta events → ""', () => {
    expect(extractStreamTextDelta({ type: 'assistant', message: {} } as unknown as AgentEvent)).toBe('');
    expect(extractStreamTextDelta({ type: 'stream', event: { type: 'message_start' } } as unknown as AgentEvent)).toBe('');
    expect(extractStreamTextDelta({ type: 'turn_end' } as unknown as AgentEvent)).toBe('');
  });
  test('malformed delta → "" (no throw)', () => {
    expect(extractStreamTextDelta(streamEv(null))).toBe('');
    expect(extractStreamTextDelta(streamEv({ type: 'text_delta' }))).toBe(''); // no .text
  });
});

describe('extractStreamThinkingDelta (F2:与 text 对称)', () => {
  test('thinking_delta → returns thinking', () => {
    expect(extractStreamThinkingDelta(streamEv({ type: 'thinking_delta', thinking: 'reasoning' }))).toBe('reasoning');
  });
  test('text_delta / partial_json / signature_delta → ""', () => {
    expect(extractStreamThinkingDelta(streamEv({ type: 'text_delta', text: 'hi' }))).toBe('');
    expect(extractStreamThinkingDelta(streamEv({ type: 'input_json_delta', partial_json: '{' }))).toBe('');
    expect(extractStreamThinkingDelta(streamEv({ type: 'signature_delta', signature: 'sig' }))).toBe('');
  });
  test('non-stream / non-content_block_delta events → ""', () => {
    expect(extractStreamThinkingDelta({ type: 'assistant', message: {} } as unknown as AgentEvent)).toBe('');
    expect(extractStreamThinkingDelta({ type: 'stream', event: { type: 'message_start' } } as unknown as AgentEvent)).toBe('');
    expect(extractStreamThinkingDelta({ type: 'turn_end' } as unknown as AgentEvent)).toBe('');
  });
  test('malformed delta → "" (no throw)', () => {
    expect(extractStreamThinkingDelta(streamEv(null))).toBe('');
    expect(extractStreamThinkingDelta(streamEv({ type: 'thinking_delta' }))).toBe(''); // no .thinking
  });
});

describe('shouldCommitStream', () => {
  const T = DEFAULT_STREAM_THROTTLE_MS;
  test('no change → false', () => {
    expect(shouldCommitStream('abc', 'abc', 0, 1e9, T)).toBe(false);
  });
  test('within throttle window (pure append, same paragraph) → false', () => {
    expect(shouldCommitStream('abcd', 'abc', 1000, 1000 + T - 1, T)).toBe(false);
  });
  test('throttle window elapsed → true', () => {
    expect(shouldCommitStream('abcd', 'abc', 1000, 1000 + T, T)).toBe(true);
  });
  test('non-append rewrite (e.g. after finalize) → true immediately', () => {
    expect(shouldCommitStream('xyz', 'abc', 0, 0, T)).toBe(true);
  });
  test('new paragraph appeared → true immediately (even inside window)', () => {
    expect(shouldCommitStream('a\n\nb', 'a', 0, 1, T)).toBe(true);
  });
  test('same paragraph count, still within window → false', () => {
    expect(shouldCommitStream('a b', 'a', 0, 1, T)).toBe(false);
  });
});
