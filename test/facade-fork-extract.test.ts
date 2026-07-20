/**
 * ForgeaxCoreKernel.forkExtract —— cache-safe 后台提取(契约 forkExtract)。
 * 验证:复用 charter/persona + history + tools 跑 fork,放行 allowedTools(经 host 桥执行)、
 * 门控其余,返回 toolCalls;capability 位为 true。
 */
import { test, expect, describe } from 'bun:test';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { ForkExtractRequest } from '@forgeax/agent-runtime/contract';

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

const forkReq = (over: Partial<ForkExtractRequest> = {}): ForkExtractRequest => ({
  session: { threadId: 'th', agentId: 'ag' },
  systemPrompt: { charter: 'CHARTER', persona: 'PERSONA' },
  history: [
    { role: 'user', content: 'make a snake game' },
    { role: 'assistant', content: 'building it' },
  ],
  tools: [
    { name: 'remember', inputSchema: {} },
    { name: 'memory_search', inputSchema: {} },
  ],
  instruction: 'Extract durable memories now.',
  allowedTools: ['remember', 'memory_search'],
  ...over,
});

describe('ForgeaxCoreKernel.forkExtract', () => {
  test('capability bit is true', () => {
    const k = new ForgeaxCoreKernel({ provider: scripted([[asstText('hi')]]), executeTool: async () => null });
    expect(k.capabilities.forkExtract).toBe(true);
  });

  test('runs an allowed memory tool via the host bridge, returns toolCalls', async () => {
    const executed: string[] = [];
    const provider = scripted([
      [asstToolUse('t1', 'remember', { kind: 'user', text: 'likes dark mode' })],
      [asstText('done')],
    ]);
    const k = new ForgeaxCoreKernel({
      provider,
      executeTool: async (name) => {
        executed.push(name);
        return { ok: true };
      },
    });
    const res = await k.forkExtract!(forkReq(), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.toolCalls).toBeGreaterThanOrEqual(1);
    expect(executed).toContain('remember'); // allowed → executed via bridge
  });

  test('gates a tool not in allowedTools (no execution)', async () => {
    const executed: string[] = [];
    const provider = scripted([
      [asstToolUse('t1', 'remember', { kind: 'user', text: 'x' })],
      [asstText('done')],
    ]);
    const k = new ForgeaxCoreKernel({
      provider,
      executeTool: async (name) => {
        executed.push(name);
        return { ok: true };
      },
    });
    // remember NOT in allowedTools → denied → host bridge never called for it
    const res = await k.forkExtract!(forkReq({ allowedTools: ['memory_search'] }), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(executed).not.toContain('remember');
  });
});
