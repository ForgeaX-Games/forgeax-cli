/**
 * codex-mapper 单测 —— Codex `exec --json` JSONL → 中立 KernelEvent 的映射(codex-ism)。
 *
 * 覆盖设计稿《通用内核接入协议》§3 事件映射:
 *   agent_message  → message.delta
 *   reasoning      → thinking.delta
 *   command/mcp item → tool.call(item.started) / tool.result(item.completed)
 *   turn.completed → turn.usage(无 costUsd) + turn.done{stop}
 *   turn.failed/error → turn.usage + error{protocol} + turn.done{error}
 *
 * 关键不变量(B5):**turn.usage 必在 turn.done 之前**(含 error 路径),
 * 否则预算/级联记账会丢一轮。这里逐路径断言该次序。
 */
import { test, expect, describe } from 'bun:test';
import type { KernelEvent } from '@forgeax/agent-runtime';
import {
  createCodexMapperState,
  flushCodexMapper,
  mapCodexEvent,
  type CodexMapperState,
  type CodexRawEvent,
} from '../src/kernel/codex-mapper';

/** 把一串 raw 事件喂给 mapper,收集所有 KernelEvent。 */
function run(raws: CodexRawEvent[], state: CodexMapperState = createCodexMapperState()): KernelEvent[] {
  const out: KernelEvent[] = [];
  for (const raw of raws) for (const ev of mapCodexEvent(raw, state)) out.push(ev);
  return out;
}

/** 断言 turn.usage 紧邻在 turn.done 之前(且都存在)。 */
function assertUsageBeforeDone(evs: KernelEvent[]): void {
  const usageIdx = evs.findIndex((e) => e.kind === 'turn.usage');
  const doneIdx = evs.findIndex((e) => e.kind === 'turn.done');
  expect(usageIdx).toBeGreaterThanOrEqual(0);
  expect(doneIdx).toBeGreaterThanOrEqual(0);
  expect(usageIdx).toBeLessThan(doneIdx);
}

describe('mapCodexEvent — item 级映射', () => {
  test('thread.started 记 thread_id,不产事件', () => {
    const state = createCodexMapperState();
    const evs = run([{ type: 'thread.started', thread_id: 'thr_123' }], state);
    expect(evs).toEqual([]);
    expect(state.threadId).toBe('thr_123');
  });

  test('agent_message item.completed → message.delta(整段)', () => {
    const evs = run([
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'hello world' } },
    ]);
    expect(evs).toEqual([{ kind: 'message.delta', role: 'assistant', text: 'hello world' }]);
  });

  test('reasoning item.completed → thinking.delta', () => {
    const evs = run([
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'let me think' } },
    ]);
    expect(evs).toEqual([{ kind: 'thinking.delta', text: 'let me think' }]);
  });

  test('command_execution started→tool.call, completed→tool.result(ok)', () => {
    const state = createCodexMapperState();
    const started = run([
      { type: 'item.started', item: { id: 't1', type: 'command_execution', command: 'ls -la' } },
    ], state);
    expect(started).toEqual([{ kind: 'tool.call', callId: 't1', name: 'shell', args: { command: 'ls -la' } }]);

    const completed = run([
      {
        type: 'item.completed',
        item: { id: 't1', type: 'command_execution', command: 'ls -la', exit_code: 0, aggregated_output: 'file.txt' },
      },
    ], state);
    expect(completed).toEqual([
      { kind: 'tool.result', callId: 't1', ok: true, result: 'file.txt', error: undefined },
    ]);
  });

  test('command_execution 非零退出 → tool.result{ok:false,error}', () => {
    const state = createCodexMapperState();
    run([{ type: 'item.started', item: { id: 't2', type: 'command_execution', command: 'false' } }], state);
    const completed = run([
      { type: 'item.completed', item: { id: 't2', type: 'command_execution', exit_code: 1, aggregated_output: 'boom' } },
    ], state);
    expect(completed[0]).toMatchObject({ kind: 'tool.result', callId: 't2', ok: false, error: 'boom' });
  });

  test('mcp tool item → tool.call(mcp__server__tool)/tool.result', () => {
    const state = createCodexMapperState();
    const started = run([
      { type: 'item.started', item: { id: 'mc1', type: 'mcp_tool_call', server: 'fxt', tool: 'list_games', arguments: { a: 1 } } },
    ], state);
    expect(started).toEqual([
      { kind: 'tool.call', callId: 'mc1', name: 'mcp__fxt__list_games', args: { a: 1 } },
    ]);
    const completed = run([
      { type: 'item.completed', item: { id: 'mc1', type: 'mcp_tool_call', status: 'completed', result: { ok: 1 } } },
    ], state);
    expect(completed).toEqual([
      { kind: 'tool.result', callId: 'mc1', ok: true, result: { ok: 1 }, error: undefined },
    ]);
  });

  test('item.completed 直发 tool item(无 started)→ 补 tool.call + tool.result', () => {
    const evs = run([
      { type: 'item.completed', item: { id: 't3', type: 'command_execution', command: 'pwd', exit_code: 0, aggregated_output: '/x' } },
    ]);
    expect(evs).toEqual([
      { kind: 'tool.call', callId: 't3', name: 'shell', args: { command: 'pwd' } },
      { kind: 'tool.result', callId: 't3', ok: true, result: '/x', error: undefined },
    ]);
  });

  test('item.started/updated 同一 id 只发一次 tool.call(去重)', () => {
    const state = createCodexMapperState();
    const a = run([{ type: 'item.started', item: { id: 'd1', type: 'command_execution', command: 'x' } }], state);
    const b = run([{ type: 'item.updated', item: { id: 'd1', type: 'command_execution', command: 'x' } }], state);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

describe('mapCodexEvent — 终态 + usage-before-done 不变量', () => {
  test('turn.completed → turn.usage(token,无 costUsd) + turn.done{stop}', () => {
    const state = createCodexMapperState();
    const evs = run([
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10 },
      },
    ], state);
    expect(evs).toEqual([
      { kind: 'turn.usage', inputTokens: 100, outputTokens: 50, cacheRead: 20 },
      { kind: 'turn.done', reason: 'stop' },
    ]);
    // costUsd 必须留空(codex 只给 token)。
    const usage = evs[0] as Extract<KernelEvent, { kind: 'turn.usage' }>;
    expect(usage.costUsd).toBeUndefined();
    assertUsageBeforeDone(evs);
    expect(state.doneEmitted).toBe(true);
  });

  test('turn.completed 无 usage → turn.usage(空) + turn.done{stop},次序不变', () => {
    const evs = run([{ type: 'turn.completed' }]);
    expect(evs).toEqual([
      { kind: 'turn.usage', inputTokens: undefined, outputTokens: undefined, cacheRead: undefined },
      { kind: 'turn.done', reason: 'stop' },
    ]);
    assertUsageBeforeDone(evs);
  });

  test('turn.failed → turn.usage + error{protocol} + turn.done{error}(次序)', () => {
    const state = createCodexMapperState();
    const evs = run([{ type: 'turn.failed', error: { message: 'model exploded' } }], state);
    expect(evs).toEqual([
      { kind: 'turn.usage' },
      { kind: 'error', error: { code: 'protocol', message: 'model exploded' } },
      { kind: 'turn.done', reason: 'error' },
    ]);
    assertUsageBeforeDone(evs);
    // error 必须夹在 usage 与 done 之间。
    expect(evs[0].kind).toBe('turn.usage');
    expect(evs[1].kind).toBe('error');
    expect(evs[2].kind).toBe('turn.done');
    expect(state.doneEmitted).toBe(true);
  });

  test('error 顶层事件(无 error.message)→ 兜底 message + 不变量保持', () => {
    const evs = run([{ type: 'error', message: 'transport gone' }]);
    expect(evs[1]).toEqual({ kind: 'error', error: { code: 'protocol', message: 'transport gone' } });
    assertUsageBeforeDone(evs);
  });

  test('终态后再来事件不重复发 done(doneEmitted 守门)', () => {
    const state = createCodexMapperState();
    run([{ type: 'turn.completed', usage: { input_tokens: 1 } }], state);
    // turn.completed mapper 自身不查 doneEmitted,但 flush 会;验证 flush 不再追加。
    const flushed = [...flushCodexMapper(state, { code: 0, stderr: '' })];
    expect(flushed).toEqual([]);
  });
});

describe('flushCodexMapper — 进程退出但无终态时的兜底', () => {
  test('exit 0 且未发终态 → turn.usage + turn.done{stop}', () => {
    const state = createCodexMapperState();
    const evs = [...flushCodexMapper(state, { code: 0, stderr: '' })];
    expect(evs).toEqual([
      { kind: 'turn.usage' },
      { kind: 'turn.done', reason: 'stop' },
    ]);
    assertUsageBeforeDone(evs);
    expect(state.doneEmitted).toBe(true);
  });

  test('exit 非零 → turn.usage + error{protocol,含 stderr 尾} + turn.done{error}', () => {
    const state = createCodexMapperState();
    const evs = [...flushCodexMapper(state, { code: 7, stderr: 'line1\nfatal: nope\n' })];
    expect(evs[0]).toEqual({ kind: 'turn.usage' });
    expect(evs[1]).toMatchObject({ kind: 'error' });
    const err = evs[1] as Extract<KernelEvent, { kind: 'error' }>;
    expect(err.error.code).toBe('protocol');
    expect(err.error.message).toContain('codex exited 7');
    expect(err.error.message).toContain('fatal: nope');
    expect(evs[2]).toEqual({ kind: 'turn.done', reason: 'error' });
    assertUsageBeforeDone(evs);
  });

  test('已发过终态 → flush 不再追加(幂等)', () => {
    const state = createCodexMapperState();
    state.doneEmitted = true;
    const evs = [...flushCodexMapper(state, { code: 1, stderr: 'x' })];
    expect(evs).toEqual([]);
  });
});
