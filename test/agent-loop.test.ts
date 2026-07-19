/**
 * Wave3 LOOP integration tests — drive CoreAgent with a stub provider + stub
 * tools through the normal/interrupt/agent_command scenarios.
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { partition, dispatchTools } from '../src/agent/dispatch';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const echoTool = buildTool({
  name: 'echo',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

const denyTool = buildTool({
  name: 'danger',
  checkPermissions: async () => ({ behavior: 'deny', message: 'nope' }),
  call: async () => ({ data: 'should-not-run' }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

function asstWithToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

/** Provider that emits a tool_use on the first call, then end_turn. */
function scriptedProvider(scripts: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
}

function ctx(tools: AgentTool[], provider: LLMProvider, maxTurns = 16): AgentContext {
  return {
    agentId: 'a1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools, maxTurns },
    toolContext: {},
  };
}

async function collect(agent: CoreAgent, input: AgentEvent extends never ? never : Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

describe('LOOP normal scenario — tool loop then complete', () => {
  test('runs tool_use turn, dispatches, then completes on end_turn', async () => {
    const provider = scriptedProvider([
      [asstWithToolUse('t1', 'echo', { v: 1 })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    const types = events.map((e) => e.type);
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.terminal.reason).toBe('completed');

    // tool actually ran
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr).toBeDefined();
  });

  test('emits all 7 stages in order on a turn', async () => {
    const provider = scriptedProvider([[asstText('hi')]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const stages = events.filter((e) => e.type === 'stage').map((e) => (e as { stage: string }).stage);
    expect(stages.slice(0, 4)).toEqual([
      'resolve_capabilities',
      'assemble_system_prompt',
      'context_compaction',
      'provider_call',
    ]);
  });
});

/** 兼容层(GLM/zai 等)不标准组合:content 里有 tool_use,但 stop_reason=end_turn。 */
function asstToolUseButEndTurn(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

describe('LOOP compat regression — tool_use must beat stop_reason=end_turn', () => {
  // 回归:兼容层返回「有 tool_use 但 stop_reason=end_turn」时,旧逻辑用 `||` 让 end_turn
  //   盖过 tool_use → 直接判完成、丢弃工具调用 → 模型思考完却静默卡死(classic_cn 首轮
  //   get_game_detail 被吞)。修复后:只要有 tool_use,必须派发,end_turn 不得提前收尾。
  test('dispatches tool even when stop_reason=end_turn, then completes next turn', async () => {
    const provider = scriptedProvider([
      [asstToolUseButEndTurn('t1', 'echo', { v: 1 })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    // 关键断言:工具确实被派发并执行,而不是被当成本轮结束吞掉。
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    // 后续第二轮纯文本 end_turn 才正常收尾。
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('no tool_use + end_turn still completes immediately (no regression)', async () => {
    const provider = scriptedProvider([[asstText('done')]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

describe('LOOP interrupt scenario', () => {
  test('emits turn_aborted + done(aborted_streaming)', async () => {
    const provider = scriptedProvider([[asstText('x')]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 }, scenario: 'interrupt' });
    expect(events.some((e) => e.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');
  });

  test('rejects a result yielded after abort by a provider that ignores signal', async () => {
    let release!: () => void;
    let markEntered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const provider: LLMProvider = {
      api: 'ignores-abort',
      async *stream() {
        markEntered();
        await blocked;
        yield asstText('must-not-be-accepted');
      },
    };
    const agent = new CoreAgent({ context: ctx([], provider) });
    const running = collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    await entered;
    agent.abort('test');
    release();

    const events = await running;
    expect(events.some((e) => e.type === 'stream')).toBe(false);
    expect(events.some((e) => e.type === 'assistant')).toBe(false);
    expect(events.some((e) => e.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');
  });
});

describe('LOOP agent_command scenario — trust channel', () => {
  test('dispatches the command tool directly, bypassing LLM', async () => {
    const provider = scriptedProvider([[asstText('never')]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, {
      input: { type: 'agent_command', payload: { name: 'echo', input: { v: 9 } }, ts: 0 },
      scenario: 'agent_command',
    });
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'stream')).toBe(false); // no LLM call
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

describe('LOOP permission gate', () => {
  test('denied tool yields an error tool_result, tool.call not run', async () => {
    const provider = scriptedProvider([
      [asstWithToolUse('t1', 'danger', {})],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([denyTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const tr = events.find((e) => e.type === 'tool_result') as { result: { payload: { isError?: boolean } } } | undefined;
    expect(tr?.result.payload.isError).toBe(true);
  });
});

describe('LOOP max_turns', () => {
  test('stops at maxTurns when model keeps requesting tools', async () => {
    // every call returns a tool_use → never ends naturally
    const provider = scriptedProvider([[asstWithToolUse('t', 'echo', {})]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider, 2) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('max_turns');
  });
});

describe('dispatch — partition serial/parallel', () => {
  test('consecutive concurrency-safe tools batch together; unsafe split', () => {
    const unsafe = buildTool({
      name: 'w',
      call: async () => ({ data: 1 }),
      mapResult: (_o, id) => ({ type: 'r', payload: { id }, ts: 0 }),
      maxResultSizeChars: 1,
    });
    const uses = [
      { id: '1', name: 'echo', input: {} },
      { id: '2', name: 'echo', input: {} },
      { id: '3', name: 'w', input: {} },
    ];
    const batches = partition(uses, [echoTool, unsafe]);
    expect(batches.length).toBe(2);
    expect(batches[0].map((u) => u.id)).toEqual(['1', '2']); // parallel batch
    expect(batches[1].map((u) => u.id)).toEqual(['3']); // serial
  });

  test('unknown tool yields error result', async () => {
    const results = await dispatchTools([{ id: 'x', name: 'nope', input: {} }], {
      tools: [echoTool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: true,
    });
    expect(results[0].isError).toBe(true);
  });
});
