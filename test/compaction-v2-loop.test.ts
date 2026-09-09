/**
 * Stream E 验收(loop 集成层):#5/#8/#6/#11。Cases E-I4..I12 + 重挂集成。
 * 见 docs/features/compaction-overhaul-verification.md §5。
 *
 * compactionV2 注入即激活新路径:比例水位 + 闸 + 三层管线 + 重挂 + 三 CompactType + pre-message。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent, type CompactionV2Options } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { buildTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import { CompactType } from '../src/context/compaction-types';

function asstText(text: string, stop: 'end_turn' = 'end_turn'): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: stop };
}
function asstToolUse(id: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'echo', input: {} }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}

const oneTurn: LLMProvider = { api: 'stub', async *stream() { yield asstText('done'); } };
function twoTurn(): LLMProvider {
  let n = 0;
  return { api: 'stub', async *stream() { yield n++ === 0 ? asstToolUse('t1') : asstText('done'); } };
}

const echo = buildTool({ name: 'echo', call: async (i: unknown) => ({ data: i }), mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 100 });

function ctx(provider: LLMProvider = oneTurn): AgentContext {
  return { agentId: 'c1', provider, config: { systemPromptSlots: [], model: 'm', tools: [echo], maxTurns: 4 }, toolContext: {} };
}

// 小窗口:contextWindow=21000, maxOut=1000 → effective=20000;preCompact=16000, emergency=18400。
const SMALL = { contextWindow: 21_000, maxOutputTokens: 1_000 };
const big = (tokens: number) => 'x'.repeat(tokens * 4); // estimateTokens = chars/4

function v2(over: Partial<CompactionV2Options> = {}): CompactionV2Options {
  return {
    summarize: async () => '<summary>compacted</summary>',
    modelInfo: SMALL,
    nowFn: () => 1_000_000,
    preMessage: false, // 多数用例先关 pre-flight,单独测
    ...over,
  };
}

async function drain(
  agent: CoreAgent,
  input: string,
  history: { role: 'user' | 'assistant'; content: unknown }[] = [],
  signal?: AbortSignal,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: input, ts: 0 }, history, signal })) out.push(e);
  return out;
}

async function settleWithin<T>(pending: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('operation did not settle after cancellation')), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe('Stream E — compaction V2 loop integration (#5/#8/#6/#11)', () => {
  test('E-I4 事件顺序 PreCompact → CompactionApplied → PostCompact', async () => {
    const bus = new EventBus();
    const seq: string[] = [];
    for (const t of [CoreEventType.PreCompact, CoreEventType.CompactionApplied, CoreEventType.PostCompact]) {
      bus.subscribe(t, (e) => { seq.push(e.type); });
    }
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]); // > emergency 18400
    const i = (t: string) => seq.indexOf(t);
    expect(i(CoreEventType.PreCompact)).toBeGreaterThanOrEqual(0);
    expect(i(CoreEventType.PreCompact)).toBeLessThan(i(CoreEventType.CompactionApplied));
    expect(i(CoreEventType.CompactionApplied)).toBeLessThan(i(CoreEventType.PostCompact));
  });

  test('E-I5 PreCompact hook blocked → 不压缩(无 CompactionApplied)', async () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.PreCompact, (e) => { (e as unknown as { blocked?: boolean }).blocked = true; });
    let applied = 0;
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    const sum = (() => { let c = 0; const f = (async () => { c++; return '<summary>x</summary>'; }) as CompactionV2Options['summarize']; (f as any).calls = () => c; return f; })();
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2({ summarize: sum }) });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(0);
    expect((sum as any).calls()).toBe(0); // summarize 也没被调
  });

  test('E-I6 CompactType:stage3 emergency 标 EMERGENCY_AUTO', async () => {
    const bus = new EventBus();
    const types: unknown[] = [];
    bus.subscribe(CoreEventType.PreCompact, (e) => { types.push((e.payload as { type?: unknown }).type); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(types).toContain(CompactType.EMERGENCY_AUTO);
  });

  test('E-I7 pre-message 预压:preCompact<tokens<emergency → PRE_MESSAGE_AUTO 触发', async () => {
    const bus = new EventBus();
    const types: unknown[] = [];
    bus.subscribe(CoreEventType.PreCompact, (e) => { types.push((e.payload as { type?: unknown }).type); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2({ preMessage: true }) });
    await drain(agent, 'q', [{ role: 'user', content: big(17_000) }]); // 16000<17000<18400
    expect(types).toContain(CompactType.PRE_MESSAGE_AUTO);
  });

  test('pre-message failure above blocking limit stops before duplicate emergency or provider request', async () => {
    const bus = new EventBus();
    const types: unknown[] = [];
    const failures: unknown[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        providerCalls++;
        yield asstText('must not be reached');
      },
    };
    bus.subscribe(CoreEventType.PreCompact, (e) => { types.push((e.payload as { type?: unknown }).type); });
    bus.subscribe(CoreEventType.CompactionFailed, (e) => { failures.push(e.payload); });
    const agent = new CoreAgent({
      context: ctx(provider),
      bus,
      compactionV2: v2({
        preMessage: true,
        summarize: async () => { throw new Error('summary output exhausted'); },
      }),
    });

    const events = await drain(agent, 'q', [{ role: 'user', content: big(20_000) }]);

    expect(types).toEqual([CompactType.PRE_MESSAGE_AUTO]);
    expect(failures).toHaveLength(1);
    expect(providerCalls).toBe(0);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('blocking_limit');
  });

  test('second-turn steering larger than prior provider usage compacts before the next provider request', async () => {
    const mainRequests: ProviderRequest[] = [];
    let mainCall = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req) {
        mainRequests.push(req);
        mainCall++;
        if (mainCall === 1) {
          yield {
            ...asstToolUse('t1'),
            usage: { ...EMPTY_USAGE, inputTokens: 100 },
          };
          return;
        }
        yield asstText('done');
      },
    };
    let steeringPoll = 0;
    let summaryCalls = 0;
    const agent = new CoreAgent({
      context: ctx(provider),
      steeringSource: () => {
        steeringPoll++;
        return steeringPoll === 2
          ? [{ role: 'user', content: `SECOND-TURN-HUGE-${big(19_000)}-TAIL` }]
          : [];
      },
      compactionV2: v2({
        preMessage: true,
        summarize: async () => {
          summaryCalls++;
          return '<summary>SECOND-TURN-COMPACTED</summary>';
        },
      }),
    });

    const events = await drain(agent, 'start');

    expect(summaryCalls).toBeGreaterThan(0);
    expect(mainRequests).toHaveLength(2);
    const secondWire = JSON.stringify(mainRequests[1]?.messages ?? []);
    expect(secondWire).toContain('SECOND-TURN-COMPACTED');
    // The lossy LLM summary is supplemented by bounded deterministic anchors,
    // so the next provider call retains both ends without replaying the body.
    expect(secondWire).toContain('SECOND-TURN-HUGE');
    expect(secondWire).toContain('-TAIL');
    expect(secondWire).not.toContain('x'.repeat(2_048));
    expect(secondWire.length).toBeLessThan(5_000);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('E-I8 CompactionApplied 载荷 + 收尾 completed', async () => {
    const bus = new EventBus();
    const applied: any[] = [];
    bus.subscribe(CoreEventType.CompactionApplied, (e) => { applied.push(e.payload); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied.length).toBe(1);
    expect(applied[0].coveredFrom).toBe(0);
    expect(applied[0].coveredTo).toBeGreaterThanOrEqual(0);
    expect(applied[0].replacement).toBeTruthy();
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('E-I10 冷却:同 now 第二轮被 cooldown 拦(仅 1 次 CompactionApplied)', async () => {
    const bus = new EventBus();
    let applied = 0;
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    // 2 turn:turn0 工具续轮(压缩)、turn1 收尾(同 now → cooldown 跳过第二次)
    const agent = new CoreAgent({ context: ctx(twoTurn()), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(1);
  });

  test('E-I11 摘要非 PTL 失败 → done(prompt_too_long)(熔断计数;不崩)', async () => {
    const agent = new CoreAgent({
      context: ctx(),
      compactionV2: v2({ summarize: async () => { throw new Error('model exploded'); } }),
    });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('prompt_too_long');
  });

  test('E-I12 字节稳定:未越线 → 无压缩,正常完成', async () => {
    const bus = new EventBus();
    let any = false;
    bus.subscribe(CoreEventType.CompactionApplied, () => { any = true; });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(1_000) }]); // 远低于 preCompact
    expect(any).toBe(false);
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('重挂集成:压后附最近文件 attachment', async () => {
    const bus = new EventBus();
    let applied = 0;
    const post: any[] = [];
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    bus.subscribe(CoreEventType.PostCompact, (event) => { post.push(event.payload); });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({
        rehydrate: {
          recentReadPaths: () => ['/missing.ts', '/a.ts', '/limited.ts'],
          readFile: async (path) => {
            if (path === '/missing.ts') throw new Error('ENOENT');
            return 'recent file body';
          },
          tokenBudget: 10_000,
          maxFiles: 1,
        },
      }),
    });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(1); // 压缩发生(重挂只在压缩后跑,不抛即通过)
    expect(post[0].rehydrate).toEqual({
      requested: 3,
      attempted: 2,
      attached: 1,
      failed: 1,
      skippedByLimit: 1,
      skippedByBudget: 0,
    });
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('active turn cancellation aborts the in-flight summary and is not counted as compaction failure', async () => {
    const bus = new EventBus();
    const failures: unknown[] = [];
    bus.subscribe(CoreEventType.CompactionFailed, (event) => { failures.push(event.payload); });
    const controller = new AbortController();
    const receivedSignals: AbortSignal[] = [];
    let summaryCalls = 0;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({
        summarize: async (_messages, _scenario, signal) => {
          if (signal) receivedSignals.push(signal);
          summaryCalls++;
          if (summaryCalls > 1) return '<summary>next turn compacted</summary>';
          notifyStarted();
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
    });

    const pending = drain(
      agent,
      'q',
      [{ role: 'user', content: big(19_000) }],
      controller.signal,
    );
    await started;
    controller.abort(new Error('cancel issue 84 compaction'));
    const events = await pending;

    expect(receivedSignals[0]?.aborted).toBe(true);
    expect(failures).toEqual([]);
    expect(events.some((event) => event.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');

    const callsAfterAbort = summaryCalls;
    const nextEvents = await drain(agent, 'next', [{ role: 'user', content: big(19_000) }]);
    expect(summaryCalls).toBeGreaterThan(callsAfterAbort);
    expect(receivedSignals.slice(callsAfterAbort).every((nextSignal) => !nextSignal.aborted)).toBe(true);
    expect(failures).toEqual([]);
    const nextLast = nextEvents.at(-1)!;
    expect(nextLast.type === 'done' && nextLast.terminal.reason).toBe('completed');
  });

  test('active turn cancellation escapes a stalled rehydrate read and releases the same agent', async () => {
    const bus = new EventBus();
    const failures: unknown[] = [];
    bus.subscribe(CoreEventType.CompactionFailed, (event) => { failures.push(event.payload); });
    const controller = new AbortController();
    let summaryCalls = 0;
    let readCalls = 0;
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({
        summarize: async () => {
          summaryCalls++;
          return '<summary>compacted before rehydrate</summary>';
        },
        rehydrate: {
          recentReadPaths: () => ['/stalled.ts'],
          readFile: async () => {
            readCalls++;
            if (readCalls === 1) {
              notifyReadStarted();
              return new Promise<string>(() => {});
            }
            return 'next turn file body';
          },
          tokenBudget: 10_000,
          maxFiles: 1,
        },
      }),
    });

    const pending = drain(
      agent,
      'q',
      [{ role: 'user', content: big(19_000) }],
      controller.signal,
    );
    await readStarted;
    controller.abort(new Error('cancel stalled issue 84 rehydrate'));
    const events = await settleWithin(pending);

    expect(failures).toEqual([]);
    expect(events.some((event) => event.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');

    const callsAfterAbort = summaryCalls;
    const nextEvents = await settleWithin(
      drain(agent, 'next', [{ role: 'user', content: big(19_000) }]),
    );
    expect(summaryCalls).toBeGreaterThan(callsAfterAbort);
    expect(readCalls).toBe(2);
    expect(failures).toEqual([]);
    const nextLast = nextEvents.at(-1)!;
    expect(nextLast.type === 'done' && nextLast.terminal.reason).toBe('completed');
  });

  test('重挂集成(内容级 · CORE-CTX-004):压后 provider 请求确含 re-attach 消息(仅注入 rehydrate 才有)', async () => {
    // 捕获压缩发生后送出的 provider 请求 messages(stage3 压缩 → stage4 发送同一 turn)。
    function capturing(): { provider: LLMProvider; reqs: ProviderRequest[] } {
      const reqs: ProviderRequest[] = [];
      return { reqs, provider: { api: 'stub', async *stream(r) { reqs.push(r); yield asstText('done'); } } };
    }

    // ① 注入 rehydrate(= 修复后的 host 行为)→ 压后请求含重挂消息 + 文件正文。
    const withReh = capturing();
    const agentWith = new CoreAgent({
      context: ctx(withReh.provider),
      compactionV2: v2({
        rehydrate: { recentReadPaths: () => ['/a.ts'], readFile: async () => 'RECENT-FILE-BODY', tokenBudget: 10_000, maxFiles: 1 },
      }),
    });
    await drain(agentWith, 'q', [{ role: 'user', content: big(19_000) }]); // > emergency 18400 → 压缩
    const withJson = JSON.stringify(withReh.reqs[0]?.messages ?? []);
    expect(withJson).toContain('Re-attached after compaction');
    expect(withJson).toContain('/a.ts');
    expect(withJson).toContain('RECENT-FILE-BODY');

    // ② 不注入 rehydrate(= 修复前的 host 行为:dead code 永不执行)→ 压后请求无重挂消息。
    const noReh = capturing();
    const agentNo = new CoreAgent({ context: ctx(noReh.provider), compactionV2: v2() });
    await drain(agentNo, 'q', [{ role: 'user', content: big(19_000) }]);
    const noJson = JSON.stringify(noReh.reqs[0]?.messages ?? []);
    expect(noJson).not.toContain('Re-attached after compaction');
  });

  test('与 legacy compaction 互斥:V2 优先,旧 strategy 不被调', async () => {
    let legacyCalled = false;
    const agent = new CoreAgent({
      context: ctx(),
      compaction: { name: 'legacy', shouldCompact: () => true, async compact() { legacyCalled = true; return { replacement: {}, coveredFrom: 0, coveredTo: 0 }; } },
      compactionV2: v2(),
    });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(legacyCalled).toBe(false);
  });
});

describe('04.4 — compaction skipped/failed 事件(skip/失败不再静默)', () => {
  test('summarize 失败 → CompactionFailed(带 error/type/trigger)', async () => {
    const bus = new EventBus();
    const failed: any[] = [];
    bus.subscribe(CoreEventType.CompactionFailed, (e) => { failed.push(e.payload); });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({ summarize: async () => { throw new Error('model exploded'); } }),
    });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toContain('model exploded');
    expect(failed[0].type).toBe(CompactType.EMERGENCY_AUTO);
    expect(failed[0].trigger).toBe('auto');
    expect(failed[0].diagnostics).toMatchObject({
      code: 'COMPACTION_REDUCTION_FAILED',
      version: 1,
      reason: 'provider_error',
      inputMessages: 2,
      providerCalls: 3,
      headTruncations: 0,
      splitCount: 2,
    });
  });

  test('熔断(3 连败)后阈值已达 → CompactionSkipped(reason=circuit-open)', async () => {
    const bus = new EventBus();
    const skipped: any[] = [];
    bus.subscribe(CoreEventType.CompactionSkipped, (e) => { skipped.push(e.payload); });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({ summarize: async () => { throw new Error('boom'); } }),
    });
    // 连续 3 次失败 → 熔断(gateState 跨 run 留在同一 agent 实例);失败阶段无 skip。
    for (let i = 0; i < 3; i++) await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(skipped.length).toBe(0);
    // 第 4 次:gate circuit-open 拦下,且 tokenCount ≥ emergency 阈值 → 发 skipped。
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe('circuit-open');
    expect(skipped[0].type).toBe(CompactType.EMERGENCY_AUTO);
    expect(skipped[0].tokenCount).toBeGreaterThanOrEqual(18_400);
  });

  test('PreCompact hook 阻断 → CompactionSkipped(reason=hook-blocked)', async () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.PreCompact, (e) => { (e as unknown as { blocked?: boolean }).blocked = true; });
    const skipped: any[] = [];
    bus.subscribe(CoreEventType.CompactionSkipped, (e) => { skipped.push(e.payload); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe('hook-blocked');
  });

  test('below-threshold 常态不发 skipped(防每轮刷 WAL)', async () => {
    const bus = new EventBus();
    const skipped: any[] = [];
    bus.subscribe(CoreEventType.CompactionSkipped, (e) => { skipped.push(e.payload); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2({ preMessage: true }) });
    await drain(agent, 'q', [{ role: 'user', content: big(1_000) }]);
    expect(skipped.length).toBe(0);
  });
});

test('successful precompact clears old usage before emergency gate and reports final rehydrated estimate', async () => {
  let calls = 0;
  const provider: LLMProvider = { api: 'stub', async *stream() {
    if (calls++ === 0) yield { ...asstToolUse('t1'), usage: { ...EMPTY_USAGE, inputTokens: 19500 } };
    else yield asstText('done');
  } };
  const bus = new EventBus();
  const pre: any[] = [], post: any[] = [];
  bus.subscribe(CoreEventType.PreCompact, (e) => { pre.push(e.payload); });
  bus.subscribe(CoreEventType.PostCompact, (e) => { post.push(e.payload); });
  const agent = new CoreAgent({ context: ctx(provider), bus, compactionV2: v2({
    preMessage: true, gateConfig: { cooldownMs: 0, maxConsecutiveFailures: 3 },
    rehydrate: { recentReadPaths: () => ['src/api.ts'], readFile: async () => 'API fact', maxFiles: 1, tokenBudget: 100 },
  }) });
  await drain(agent, 'q');
  expect(pre).toHaveLength(1);
  expect(pre[0].tokenCount).toBe(19500);
  expect(pre[0].threshold).toBe(16000);
  expect(post).toHaveLength(1);
  expect(post[0].postTokens).toBeGreaterThan(0);
  expect(post[0].postTokens).toBeLessThan(1000);
  expect(post[0].tokenBasis).toBe('estimate');
});
