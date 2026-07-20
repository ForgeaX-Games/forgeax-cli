/**
 * Wave4 FACADE tests — ForgeaxCoreKernel implements the AgentKernel contract:
 * maps TurnRequest → CoreAgent, consumes history, emits KernelEvents with the
 * usage-before-done invariant (B5).
 */
import { test, expect, describe } from 'bun:test';
import { ForgeaxCoreKernel, translateNeutral } from '../src/kernel-facade/forgeax-core-kernel';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';
import type { HandoffSink, HandoffIntent } from '../src/inject/types';
import { buildTool, type AgentTool } from '../src/capability/types';

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
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
function scripted(scripts: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const t = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of t) yield ev;
    },
  };
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    session: { threadId: 'th', agentId: 'ag' },
    input: { text: 'hello' },
    systemPrompt: { charter: 'CHARTER', persona: 'PERSONA' },
    tools: [{ name: 'echo', inputSchema: {} }],
    budget: { maxTurns: 8 },
    ...over,
  };
}

async function collect(kernel: ForgeaxCoreKernel, r: TurnRequest, signal?: AbortSignal): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const e of kernel.runTurn(r, signal ?? new AbortController().signal)) out.push(e);
  return out;
}

describe('ForgeaxCoreKernel — contract identity', () => {
  test('id + capabilities', () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('hi')]]), executeTool: async () => null });
    expect(k.id).toBe('forgeax-core');
    expect(k.capabilities.toolCalls).toBe(true);
  });
  test('probe ok', async () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('hi')]]), executeTool: async () => null });
    const h = await k.probe();
    expect(h.ok).toBe(true);
    expect(h.kernelId).toBe('forgeax-core');
  });
});

describe('ForgeaxCoreKernel — peer 多 agent handoff seam(forgeax-cli 专属,不上契约)', () => {
  test('注入 handoff 每轮工厂 → Handoff 工具上线 + declare 被调(本轮 ctx 正确) + child_result 折回 + 完成', async () => {
    const declared: HandoffIntent[] = [];
    const ctxSeen: Array<{ model: string; toolCount: number }> = [];
    const fakeSink: HandoffSink = {
      async declare(intent) {
        declared.push(intent);
        return {
          kind: 'child_result',
          events: [
            { type: 'assistant.message', payload: { role: 'assistant', content: [{ type: 'text', text: 'CHILD-OUT' }] }, ts: 0 },
          ],
        };
      },
    };
    const k = new ForgeaxCoreKernel({
      provider: scripted([
        [asstToolUse('h1', 'Handoff', { kind: 'spawn_child', spec: { type: 'helper' }, mode: 'fg' })],
        [asstText('parent-final')],
      ]),
      executeTool: async () => null,
      handoff: (c) => {
        ctxSeen.push({ model: c.model, toolCount: c.tools.length });
        return fakeSink;
      },
    });
    const events = await collect(k, req());
    // facade 注入 handoff 后把内建 Handoff 工具加进模型工具集 → 模型得以调用。
    expect(events.some((e) => e.kind === 'tool.call' && e.name === 'Handoff')).toBe(true);
    // 每轮工厂拿到本轮 model + host 工具(子 agent 同源工具的来源)。
    expect(ctxSeen.length).toBeGreaterThan(0);
    expect(ctxSeen[0].model).toBeTruthy();
    // declare 被调且 intent 正确。
    expect(declared.length).toBe(1);
    expect(declared[0].kind).toBe('spawn_child');
    // 整轮正常收口。
    expect(events.some((e) => e.kind === 'turn.done' && (e as { reason: string }).reason === 'stop')).toBe(true);
  });

  test('不注入 handoff → 无 Handoff 工具,普通单 agent 轮(零行为变化回归)', async () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('hi')]]), executeTool: async () => null });
    const events = await collect(k, req());
    expect(events.some((e) => e.kind === 'tool.call' && e.name === 'Handoff')).toBe(false);
    expect(events.some((e) => e.kind === 'turn.done')).toBe(true);
  });
});

describe('ForgeaxCoreKernel — runTurn maps a full turn', () => {
  test('tool turn → tool.call + tool.result via host bridge, then turn.done(stop)', async () => {
    const calls: string[] = [];
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]),
      executeTool: async (name, args) => {
        calls.push(name);
        return { echoed: args };
      },
    });
    const events = await collect(k, req());
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool.call');
    expect(kinds).toContain('tool.result');
    expect(calls).toEqual(['echo']); // host-tool bridge invoked

    // B5 invariant: turn.usage strictly before turn.done
    const ui = kinds.indexOf('turn.usage');
    const di = kinds.indexOf('turn.done');
    expect(ui).toBeGreaterThanOrEqual(0);
    expect(di).toBeGreaterThan(ui);
    const done = events[di] as { kind: 'turn.done'; reason: string };
    expect(done.reason).toBe('stop');
  });

  test('emits message.delta for assistant text', async () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('hi there')]]), executeTool: async () => null });
    const events = await collect(k, req({ tools: [] }));
    const md = events.find((e) => e.kind === 'message.delta') as { text: string } | undefined;
    expect(md?.text).toBe('hi there');
  });

  test('streams per-token message.delta from text_delta, no duplication from aggregated assistant', async () => {
    // provider 流式路:逐 token content_block_delta + 收尾聚合 assistant(anthropic.ts 真实形状)。
    const chunks = ['Hel', 'lo ', 'wor', 'ld'];
    const full = chunks.join('');
    const streamScript: ProviderStreamEvent[] = [
      { type: 'content_block_start', index: 0, blockType: 'text' },
      ...chunks.map((c): ProviderStreamEvent => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } })),
      { type: 'content_block_stop', index: 0, block: { type: 'text', text: full } },
      asstText(full),
    ];
    const k = new ForgeaxCoreKernel({ provider: scripted([streamScript]), executeTool: async () => null });
    const events = await collect(k, req({ tools: [] }));
    const deltas = events.filter((e): e is Extract<KernelEvent, { kind: 'message.delta' }> => e.kind === 'message.delta');
    // 逐 token 流出(浏览器打字机的数据源),而非一轮一次性全文。
    expect(deltas.length).toBe(chunks.length);
    expect(deltas.map((d) => d.text)).toEqual(chunks);
    // 聚合 assistant 不重发已流出文本 → join 恰好等于全文,零重复。
    expect(deltas.map((d) => d.text).join('')).toBe(full);
  });

  test('aggregated assistant emits only the residual tail beyond streamed deltas', async () => {
    // 聚合文本比增量多一截(结构上少见,防御路):只补余量,不双份。
    const streamScript: ProviderStreamEvent[] = [
      { type: 'content_block_start', index: 0, blockType: 'text' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      asstText('partial+tail'),
    ];
    const k = new ForgeaxCoreKernel({ provider: scripted([streamScript]), executeTool: async () => null });
    const events = await collect(k, req({ tools: [] }));
    const deltas = events.filter((e): e is Extract<KernelEvent, { kind: 'message.delta' }> => e.kind === 'message.delta');
    expect(deltas.map((d) => d.text)).toEqual(['partial', '+tail']);
  });
});

describe('ForgeaxCoreKernel — consumes TurnRequest.history (native context ownership)', () => {
  test('history seeded does not crash and completes', async () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('ok')]]), executeTool: async () => null });
    const events = await collect(
      k,
      req({
        tools: [],
        history: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'earlier reply' },
          { role: 'tool', callId: 'c1', ok: true, result: 'r' },
        ],
      }),
    );
    const done = events.find((e) => e.kind === 'turn.done') as { reason: string } | undefined;
    expect(done?.reason).toBe('stop');
  });
});

describe('ForgeaxCoreKernel — translateNeutral (neutral → engine native)', () => {
  test('4 mappings', () => {
    expect(translateNeutral('gated')).toBe('default');
    expect(translateNeutral('autoEdits')).toBe('acceptEdits');
    expect(translateNeutral('planning')).toBe('plan');
    expect(translateNeutral('unrestricted')).toBe('bypassPermissions');
  });
});

describe('ForgeaxCoreKernel — setPermissionMode live + injected rules honored', () => {
  test('openHandle.setPermissionMode("planning") → subsequent dispatch denies non-readonly writes', async () => {
    // host tool spec → wrapped (default isReadOnly=false) → plan mode denies it.
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('w1', 'write_file', { file_path: '/x' })], [asstText('done')]]),
      executeTool: async () => ({ ok: true }),
    });
    // no live turn yet: setPermissionMode stores into kernel.currentMode → new agent picks it up.
    await k.openHandle('whatever').setPermissionMode('planning');
    const events = await collect(k, req({ callId: 'c1', tools: [{ name: 'write_file', inputSchema: {} }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean; result?: unknown } | undefined;
    expect(tr).toBeDefined();
    // denied by plan mode → ok=false (host bridge never invoked).
    expect(tr!.ok).toBe(false);
  });

  test('injected deny rule takes effect in a facade-driven turn (rules threaded to CoreAgent)', async () => {
    let bridgeCalls = 0;
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('e1', 'echo', { v: 1 })], [asstText('done')]]),
      executeTool: async () => {
        bridgeCalls++;
        return { ok: true };
      },
      rules: { deny: [{ toolName: 'echo', behavior: 'deny' }], ask: [], allow: [] },
    });
    const events = await collect(k, req({ callId: 'c2' }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr).toBeDefined();
    expect(tr!.ok).toBe(false); // deny rule honored
    expect(bridgeCalls).toBe(0); // host-tool bridge never reached (denied before call)
  });
});

describe('ForgeaxCoreKernel — ExitPlanMode conditional surfacing', () => {
  test('plan mode → ExitPlanMode tool present in model tool set (approved via askUser)', async () => {
    // model immediately tries ExitPlanMode; if absent it would be an unknown_tool error.
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('x1', 'ExitPlanMode', { plan: 'p' })], [asstText('done')]]),
      executeTool: async () => null,
      initialMode: 'plan',
      askUser: async () => true, // 007:出口是 ask 闸,approve 后才执行
    });
    const events = await collect(k, req({ callId: 'p1', tools: [] }));
    const call = events.find((e) => e.kind === 'tool.call' && e.name === 'ExitPlanMode');
    expect(call).toBeDefined();
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    // ExitPlanMode is read-only-exempt → allowed → ok (not an unknown-tool / denied error).
    expect(tr?.ok).toBe(true);
  });

  test('007: plan mode + no askUser → exit gate fail-closed(调用被 deny,留在 plan)', async () => {
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('x1', 'ExitPlanMode', { plan: 'p' })], [asstText('done')]]),
      executeTool: async () => null,
      initialMode: 'plan',
    });
    const events = await collect(k, req({ callId: 'p2', tools: [] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(false); // ask 无人应答 → deny
  });

  test('007: approved exit 后 facade 轮终回读模式 —— 下一轮不再按 plan 构造(写可执行)', async () => {
    const k = new ForgeaxCoreKernel({
      provider: scripted([
        [asstToolUse('x1', 'ExitPlanMode', { plan: 'p' })], // turn A:获批退出
        [asstText('done')],
        [asstToolUse('w1', 'write_file', { file_path: '/x' })], // turn B:写(plan 下必 deny)
        [asstText('done')],
      ]),
      executeTool: async () => ({ ok: true }),
      askUser: async () => true,
    });
    const h = k.openHandle('h');
    await h.setPermissionMode('autoEdits'); // 进入 plan 前的模式
    await h.setPermissionMode('planning');
    await collect(k, req({ callId: 'a', tools: [{ name: 'write_file', inputSchema: {} }] }));
    const b = await collect(k, req({ callId: 'b', tools: [{ name: 'write_file', inputSchema: {} }] }));
    const tr = b.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    // 修复前:facade currentMode 停在 'plan',turn B 的写被 plan-deny(ok=false)。
    expect(tr?.ok).toBe(true);
  });

  test('default mode → ExitPlanMode tool absent (calling it → unknown tool error)', async () => {
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('x1', 'ExitPlanMode', { plan: 'p' })], [asstText('done')]]),
      executeTool: async () => null,
    });
    const events = await collect(k, req({ callId: 'd1', tools: [] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    // tool not in set → dispatch returns unknown_tool error → ok=false.
    expect(tr?.ok).toBe(false);
  });
});

// P0.1 — setModel 接真(facade no-op → 改活 + 持久,镜像 setPermissionMode)。
function capturingModel(scripts: ProviderStreamEvent[][], sink: { model?: string }): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream(rq: unknown) {
      sink.model = (rq as { model?: string }).model;
      const t = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of t) yield ev;
    },
  } as LLMProvider;
}

describe('ForgeaxCoreKernel — setModel 控制面覆盖(P0.1)', () => {
  test('openHandle.setModel(X) → 后续轮 provider 请求用模型 X(覆盖 req.model)', async () => {
    const sink: { model?: string } = {};
    const k = new ForgeaxCoreKernel({ provider: capturingModel([[asstText('ok')]], sink), executeTool: async () => null });
    await k.openHandle('h').setModel('model-override-x');
    await collect(k, req({ callId: 'm1', model: 'req-model-ignored', tools: [] }));
    expect(sink.model).toBe('model-override-x');
  });

  test('未 setModel → 用 req.model(零行为变化)', async () => {
    const sink: { model?: string } = {};
    const k = new ForgeaxCoreKernel({ provider: capturingModel([[asstText('ok')]], sink), executeTool: async () => null });
    await collect(k, req({ callId: 'm2', model: 'req-model-y', tools: [] }));
    expect(sink.model).toBe('req-model-y');
  });
});

// P0.3 — TurnRequest.permissionMode:本轮起始模式,免一次 setPermissionMode 控制面往返。
describe('ForgeaxCoreKernel — TurnRequest.permissionMode 起始模式(P0.3)', () => {
  test('req.permissionMode="planning" → 本轮起即 plan,写工具被拒(askUser=allow 也拦不住 plan deny)', async () => {
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('w1', 'write_file', { file_path: '/x' })], [asstText('done')]]),
      executeTool: async () => ({ ok: true }),
      askUser: async () => true, // plan 是 deny 非 ask,askUser 放行也无效 → 证明确是 plan 拦
    });
    const events = await collect(k, req({ callId: 'pm1', permissionMode: 'planning', tools: [{ name: 'write_file', inputSchema: {} }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(false);
  });

  test('req.permissionMode="gated" → 写工具经 ask 放行(对照)', async () => {
    let bridge = 0;
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('w1', 'write_file', { file_path: '/x' })], [asstText('done')]]),
      executeTool: async () => {
        bridge++;
        return { ok: true };
      },
      askUser: async () => true,
    });
    const events = await collect(k, req({ callId: 'pm2', permissionMode: 'gated', tools: [{ name: 'write_file', inputSchema: {} }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(true);
    expect(bridge).toBe(1);
  });
});

// CORE-CTX-004 — 压后重挂在 facade host 真被装配(D-01:loop 内部 read-tracker 记读 → 注入 rehydrate → 压后重挂)。
//   验证「dead code 已接线」:发现者报的 bug 是 3 个 host 从不注入 rehydrate。这里驱动真 kernel:
//   turn0 读文件(usage 撑大 → 越 emergency),turn1 触发压缩,断言压后请求含 re-attach 消息。
describe('ForgeaxCoreKernel — 压后重挂 host 接线(CORE-CTX-004)', () => {
  const readBig = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { file_path: '/x.ts' } }] },
    usage: { ...EMPTY_USAGE, inputTokens: 190_000 } as Usage, // > emergency(opus 200k → 165600)
    stopReason: 'tool_use',
  } as ProviderStreamEvent;

  /** 记录每次 provider 请求的 capturing + 按调用序脚本化 provider。 */
  function capturing(scripts: ProviderStreamEvent[][]): { provider: LLMProvider; reqs: ProviderRequest[] } {
    const reqs: ProviderRequest[] = [];
    let call = 0;
    return {
      reqs,
      provider: {
        api: 'stub',
        async *stream(r) {
          reqs.push(r as ProviderRequest);
          const t = scripts[Math.min(call, scripts.length - 1)];
          call++;
          for (const ev of t) yield ev;
        },
      },
    };
  }

  test('toolContext 带 sandboxFs → 压后请求含 re-attach + 文件正文(接线生效)', async () => {
    const cap = capturing([[readBig], [asstText('SUMMARY')], [asstText('done')]]);
    const k = new ForgeaxCoreKernel({
      provider: cap.provider,
      executeTool: async () => ({ ok: true, content: 'file bytes' }),
      toolContext: { sandboxFs: { readText: async (p: string) => `BODY-OF:${p}` } },
    });
    await collect(k, req({ callId: 'reh1', tools: [{ name: 'read_file', inputSchema: {} }] }));
    const anyReattach = cap.reqs.some((r) => JSON.stringify(r.messages).includes('Re-attached after compaction'));
    const anyBody = cap.reqs.some((r) => JSON.stringify(r.messages).includes('BODY-OF:/x.ts'));
    expect(anyReattach).toBe(true);
    expect(anyBody).toBe(true);
  });

  test('对照:toolContext 无 sandboxFs → rehydrate 不注入,压后无 re-attach(优雅降级)', async () => {
    const cap = capturing([[readBig], [asstText('SUMMARY')], [asstText('done')]]);
    const k = new ForgeaxCoreKernel({
      provider: cap.provider,
      executeTool: async () => ({ ok: true, content: 'file bytes' }),
      // 不给 sandboxFs → rehydrateFs undefined → rehydrate 不接。
    });
    await collect(k, req({ callId: 'reh2', tools: [{ name: 'read_file', inputSchema: {} }] }));
    const anyReattach = cap.reqs.some((r) => JSON.stringify(r.messages).includes('Re-attached after compaction'));
    expect(anyReattach).toBe(false);
  });
});

describe('ForgeaxCoreKernel — abort', () => {
  test('pre-aborted signal → usage before done(cancelled)', async () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('x')]]), executeTool: async () => null });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(k, req({ tools: [] }), ac.signal);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('turn.usage')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('turn.done')).toBeGreaterThan(kinds.indexOf('turn.usage'));
    const done = events.find((e) => e.kind === 'turn.done') as { reason: string };
    expect(done.reason).toBe('cancelled');
  });
});

// P2 — delivery 二分(B 路径):local→本地实现直跑(不回宿主);host/缺省→executeTool 桥。
function spyLocalTool(name: string, onCall: () => void): AgentTool {
  return buildTool({
    name,
    inputJSONSchema: {},
    call: async (input: unknown) => {
      onCall();
      return { data: { local: true, input } };
    },
    mapResult: (data, id) => ({ type: 'tool.result', payload: { callId: id, ok: true, result: data }, ts: 0 }),
    maxResultSizeChars: Infinity,
  });
}

describe('ForgeaxCoreKernel — delivery 二分(B 路径)', () => {
  test('delivery="local" 且有同名本地实现 → 本地直跑,executeTool 桥不被调', async () => {
    let local = 0;
    let bridge = 0;
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('s1', 'safe_tool', { v: 1 })], [asstText('done')]]),
      executeTool: async () => {
        bridge++;
        return { viaHost: true };
      },
      localToolImpls: [spyLocalTool('safe_tool', () => local++)],
    });
    const events = await collect(k, req({ callId: 'L1', tools: [{ name: 'safe_tool', inputSchema: {}, delivery: 'local' }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(true);
    expect(local).toBe(1); // 本地实现被调
    expect(bridge).toBe(0); // 桥未被调(没回宿主)
  });

  test('delivery 缺省(host)→ 走 executeTool 桥,本地实现不被调(即便注入了同名)', async () => {
    let local = 0;
    let bridge = 0;
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('s1', 'safe_tool', { v: 1 })], [asstText('done')]]),
      executeTool: async () => {
        bridge++;
        return { viaHost: true };
      },
      localToolImpls: [spyLocalTool('safe_tool', () => local++)],
    });
    const events = await collect(k, req({ callId: 'H1', tools: [{ name: 'safe_tool', inputSchema: {} }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(true);
    expect(bridge).toBe(1); // 缺省回桥
    expect(local).toBe(0);
  });

  test('delivery="local" 但无同名本地实现 → fail-safe 落回 executeTool 桥', async () => {
    let bridge = 0;
    const k = new ForgeaxCoreKernel({
      provider: scripted([[asstToolUse('s1', 'missing_local', { v: 1 })], [asstText('done')]]),
      executeTool: async () => {
        bridge++;
        return { viaHost: true };
      },
      localToolImpls: [],
    });
    const events = await collect(k, req({ callId: 'F1', tools: [{ name: 'missing_local', inputSchema: {}, delivery: 'local' }] }));
    const tr = events.find((e) => e.kind === 'tool.result') as { ok: boolean } | undefined;
    expect(tr?.ok).toBe(true);
    expect(bridge).toBe(1); // 缺实现 → fail-safe 回桥
  });
});

describe('ForgeaxCoreKernel — toolPolicy 裁剪内建工具(验收报告 D.3)', () => {
  // 捕获本轮呈递给模型的工具名(第一次 stream 调用的 ProviderRequest.tools)。
  function capturingProvider(seen: string[][]): LLMProvider {
    return {
      api: 'stub',
      async *stream(r: ProviderRequest) {
        seen.push(r.tools.map((t) => t.name));
        yield asstText('ok');
      },
    };
  }

  test('缺省(无 policy)→ 内建 Task 随 host 工具一同上线(现状回归)', async () => {
    const seen: string[][] = [];
    const k = new ForgeaxCoreKernel({ provider: capturingProvider(seen), executeTool: async () => null });
    await collect(k, req({ tools: [{ name: 'echo', inputSchema: {} }] }));
    expect(seen[0]).toContain('echo');
    expect(seen[0]).toContain('Task');
  });

  test('toolPolicy.deny:[Task] → Task 从模型工具集移除,host 工具保留', async () => {
    const seen: string[][] = [];
    const k = new ForgeaxCoreKernel({ provider: capturingProvider(seen), executeTool: async () => null });
    await collect(k, req({ tools: [{ name: 'echo', inputSchema: {} }], toolPolicy: { deny: ['Task'] } }));
    expect(seen[0]).toContain('echo');
    expect(seen[0]).not.toContain('Task');
  });

  test('toolPolicy.deny 通配 mcp__* → 前缀命中的 host 工具被剔,其余保留', async () => {
    const seen: string[][] = [];
    const k = new ForgeaxCoreKernel({ provider: capturingProvider(seen), executeTool: async () => null });
    await collect(k, req({
      tools: [{ name: 'echo', inputSchema: {} }, { name: 'mcp__x__foo', inputSchema: {} }],
      toolPolicy: { deny: ['mcp__*'] },
    }));
    expect(seen[0]).toContain('echo');
    expect(seen[0]).not.toContain('mcp__x__foo');
  });

  test('toolPolicy.allow 独占白名单 → 仅命中项保留(含内建也被卡)', async () => {
    const seen: string[][] = [];
    const k = new ForgeaxCoreKernel({ provider: capturingProvider(seen), executeTool: async () => null });
    await collect(k, req({
      tools: [{ name: 'echo', inputSchema: {} }, { name: 'read_file', inputSchema: {} }],
      toolPolicy: { allow: ['echo'] },
    }));
    expect(seen[0]).toEqual(['echo']);
  });
});
