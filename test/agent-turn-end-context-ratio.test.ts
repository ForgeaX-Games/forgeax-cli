/**
 * 验收 03.5 — turn_end 携带 usageContextRatio(P0)
 * 修复 t05-turn-end-ctxpct:agent.ts 所有 turn_end 都未设 usageContextRatio → 状态栏 ctx% 永不刷新。
 */
import { test, expect } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstEnd(inputTokens: number): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    usage: { ...EMPTY_USAGE, inputTokens } as Usage,
    stopReason: 'end_turn',
  };
}

function ctx(provider: LLMProvider): AgentContext {
  return {
    agentId: 'a1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 4 },
    toolContext: {},
  };
}

test('turn_end 携带 usageContextRatio ∈ (0,1] (验收 03.5)', async () => {
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() { yield asstEnd(1_000); },
  };

  const agent = new CoreAgent({
    context: ctx(provider),
    contextWindow: 10_000,
  });

  const events: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
    events.push(e);
  }

  const turnEnd = events.find((e) => e.type === 'turn_end');
  expect(turnEnd).toBeDefined();
  if (turnEnd?.type === 'turn_end') {
    const ratio = turnEnd.usageContextRatio;
    expect(ratio).toBeDefined();
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
    // 1000 / 10000 = 0.1
    expect(ratio).toBeCloseTo(0.1, 5);
  }
});

test('turn_end usageContextRatio 为 undefined 当 provider 未返回 usage (兜底)', async () => {
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() { yield asstEnd(0); },
  };

  const agent = new CoreAgent({ context: ctx(provider), contextWindow: 10_000 });

  const events: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
    events.push(e);
  }

  const turnEnd = events.find((e) => e.type === 'turn_end');
  expect(turnEnd?.type).toBe('turn_end');
  if (turnEnd?.type === 'turn_end') {
    expect(turnEnd.usageContextRatio).toBeUndefined();
  }
});

test('turn_end usageContextRatio 使用 lookupModelContext 兜底窗口(无显式 contextWindow)', async () => {
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() { yield asstEnd(1_000); },
  };

  // 不传 contextWindow → 走 lookupModelContext('m') → FALLBACK 200_000
  const agent = new CoreAgent({ context: ctx(provider) });

  const events: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
    events.push(e);
  }

  const turnEnd = events.find((e) => e.type === 'turn_end');
  if (turnEnd?.type === 'turn_end') {
    // 1000 / 200000 = 0.005 — 仍 > 0 且 ≤ 1
    expect(turnEnd.usageContextRatio).toBeGreaterThan(0);
    expect(turnEnd.usageContextRatio).toBeLessThanOrEqual(1);
  }
});
