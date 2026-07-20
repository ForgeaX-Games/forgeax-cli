/**
 * WS-C — CoreAgent runtime permission-mode switching (setMode) + ExitPlanMode sentinel.
 * 007 — plan 出口人类闸(ask)+ prePlanMode 恢复 + loop 注入(直连路径也拿到工具)。
 *
 * 用脚本化 fake provider 驱动 CoreAgent(不调真 API):
 *   - setMode('plan') 后,模型发 write 工具 → tool_result 必是 permission-denied;
 *   - 模型发 ExitPlanMode:**askUser approve** 后 sentinel 才生效 → loop 恢复进入前模式;
 *     reject / 无 askUser → fail-closed deny,停在 plan;
 *   - plan 下 ExitPlanMode 由 loop 逐轮注入,host 工具集无需自带。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import { exitPlanModeTool } from '../src/capability/builtin-tools/plan-tools';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const writeTool = buildTool({
  name: 'write_file',
  isDestructive: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, isError: false, result: o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

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
    // cwd = /repo so the scripted `/repo/a.ts` writes are in-cwd: this suite exercises
    // plan-mode / default-mode gating, not the CWE-22 cwd-escape guard (T3).
    toolContext: { cwd: '/repo' },
  };
}
async function collect(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}
function toolResults(events: AgentEvent[]): Array<{ toolUseId: string; payload: Record<string, unknown> }> {
  return events
    .filter((e) => e.type === 'tool_result')
    .map((e) => {
      const ev = e as { toolUseId: string; result: { payload: unknown } };
      return { toolUseId: ev.toolUseId, payload: ev.result.payload as Record<string, unknown> };
    });
}

describe('CoreAgent — plan mode denies writes, ExitPlanMode flips to default', () => {
  test('plan: write tool_use → permission-denied; after ExitPlanMode (approved) → write allowed', async () => {
    const provider = scriptedProvider([
      // turn 0: write under plan → denied
      [asstToolUse('w1', 'write_file', { file_path: '/repo/a.ts', content: 'x' })],
      // turn 1: exit plan mode (sentinel) → flips currentMode to default
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'write the file' })],
      // turn 2: write again → now allowed
      [asstToolUse('w2', 'write_file', { file_path: '/repo/a.ts', content: 'x' })],
      // turn 3: done
      [asstText('done')],
    ]);
    const agent = new CoreAgent({
      context: ctx([writeTool, exitPlanModeTool()], provider),
      mode: 'plan',
      askUser: async () => true, // 007:出口是 ask 闸,人类 approve 后才翻模式
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const trs = toolResults(events);

    const w1 = trs.find((r) => r.toolUseId === 'w1');
    expect(w1).toBeDefined();
    expect(w1!.payload.isError).toBe(true);
    expect(String(w1!.payload.message ?? '')).toContain('plan mode');

    const e1 = trs.find((r) => r.toolUseId === 'e1');
    expect(e1).toBeDefined();
    expect(e1!.payload.isError).toBeFalsy();

    const w2 = trs.find((r) => r.toolUseId === 'w2');
    expect(w2).toBeDefined();
    // after exiting plan mode, write is no longer plan-denied.
    expect(w2!.payload.isError).toBeFalsy();
    expect(agent.getMode()).toBe('default');
  });

  test('007: ExitPlanMode rejected by human → stays in plan, writes still denied', async () => {
    const provider = scriptedProvider([
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })],
      [asstToolUse('w1', 'write_file', { file_path: '/repo/a.ts', content: 'x' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({
      context: ctx([writeTool, exitPlanModeTool()], provider),
      mode: 'plan',
      askUser: async () => false, // 人类 reject
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const trs = toolResults(events);
    const e1 = trs.find((r) => r.toolUseId === 'e1');
    expect(e1!.payload.isError).toBe(true); // deny 落成工具错误结果
    const w1 = trs.find((r) => r.toolUseId === 'w1');
    expect(w1!.payload.isError).toBe(true); // 仍在 plan,写仍被拦
    expect(agent.getMode()).toBe('plan');
  });

  test('007: no askUser wired → fail-closed deny, stays in plan', async () => {
    const provider = scriptedProvider([
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([writeTool, exitPlanModeTool()], provider), mode: 'plan' });
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const e1 = toolResults(events).find((r) => r.toolUseId === 'e1');
    expect(e1!.payload.isError).toBe(true);
    expect(agent.getMode()).toBe('plan');
  });

  test('007: exit restores pre-plan mode (acceptEdits → plan → exit → acceptEdits)', async () => {
    const provider = scriptedProvider([
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({
      context: ctx([writeTool, exitPlanModeTool()], provider),
      mode: 'acceptEdits',
      askUser: async () => true,
    });
    agent.setMode('plan'); // 进 plan,自动记录 prePlanMode='acceptEdits'
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const e1 = toolResults(events).find((r) => r.toolUseId === 'e1');
    expect(e1!.payload.isError).toBeFalsy();
    expect(agent.getMode()).toBe('acceptEdits'); // 恢复进入前模式,非硬编码 default
  });

  test('007: options.prePlanMode(facade 每轮重建路径)→ exit 恢复它', async () => {
    const provider = scriptedProvider([
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({
      context: ctx([writeTool, exitPlanModeTool()], provider),
      mode: 'plan',
      prePlanMode: 'acceptEdits',
      askUser: async () => true,
    });
    await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    expect(agent.getMode()).toBe('acceptEdits');
  });

  test('007: loop injects ExitPlanMode in plan mode(host 工具集不含它,直连路径)', async () => {
    const provider = scriptedProvider([
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })],
      [asstText('done')],
    ]);
    // 注意:tools 里没有 exitPlanModeTool —— 由 loop 在 plan 轮注入。
    const agent = new CoreAgent({
      context: ctx([writeTool], provider),
      mode: 'plan',
      askUser: async () => true,
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const e1 = toolResults(events).find((r) => r.toolUseId === 'e1');
    expect(e1).toBeDefined();
    expect(e1!.payload.isError).toBeFalsy(); // 不是 unknown_tool —— 注入生效
    expect(agent.getMode()).toBe('default');
  });

  test('setMode("plan") at runtime then write → denied (mode is live, not from o.mode)', async () => {
    const provider = scriptedProvider([
      [asstToolUse('w1', 'write_file', { file_path: '/repo/a.ts', content: 'x' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([writeTool], provider) }); // default mode
    agent.setMode('plan'); // switch before run
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const w1 = toolResults(events).find((r) => r.toolUseId === 'w1');
    expect(w1!.payload.isError).toBe(true);
    expect(String(w1!.payload.message ?? '')).toContain('plan mode');
  });

  test('default mode (no setMode) → write runs (regression: zero behavior change)', async () => {
    const provider = scriptedProvider([
      [asstToolUse('w1', 'write_file', { file_path: '/repo/a.ts', content: 'x' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([writeTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'go', ts: 0 } });
    const w1 = toolResults(events).find((r) => r.toolUseId === 'w1');
    expect(w1!.payload.isError).toBeFalsy();
  });
});
