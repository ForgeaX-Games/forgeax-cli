/**
 * runForkedAgent —— cache-safe fork 原语单测。
 *
 * 断言三大不变量(缓存命中的前提):
 *   1. fork 请求的 messages 前缀 **== 父 parentMessages**,只在尾部**追加一条 user 指令**;
 *   2. system/model/tools 来自注入(同父)→ 缓存键一致;
 *   3. 门控(canUseTool)**只拦执行、不改工具定义**:被拒工具**仍在请求 tools 里**(缓存不破),
 *      但其 call **不执行**。
 * 另测 writtenPaths 从 Write tool_use 抽取。
 */
import { test, expect, describe } from 'bun:test';
import { runForkedAgent } from '../src/agent/forked-agent';
import { buildTool } from '../src/capability/types';
import type { LLMProvider, ProviderStreamEvent, ProviderRequest, Usage, ProviderMessage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

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

/** Provider that records every request and replays a per-call script. */
function recordingProvider(scripts: ProviderStreamEvent[][]): { provider: LLMProvider; reqs: ProviderRequest[] } {
  const reqs: ProviderRequest[] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest) {
      reqs.push(req);
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
  return { provider, reqs };
}

const parentMessages: ProviderMessage[] = [
  { role: 'user', content: 'make me a platformer' },
  { role: 'assistant', content: 'sure, building it now' },
];

describe('runForkedAgent — cache-safe fork', () => {
  test('reuses parent messages as prefix, appends exactly one user instruction', async () => {
    const writeTool = buildTool({
      name: 'Write',
      isConcurrencySafe: () => true,
      isReadOnly: () => false,
      call: async (i: unknown) => ({ data: i }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider, reqs } = recordingProvider([
      [asstToolUse('w1', 'Write', { file_path: '/mem/traits/fav.md', content: 'x' })],
      [asstText('saved')],
    ]);

    const res = await runForkedAgent(
      { parentMessages, model: 'parent-model', tools: [writeTool], instruction: 'Extract durable memories now.' },
      { provider },
    );

    // first request: prefix == parentMessages, +1 appended user message
    const first = reqs[0];
    expect(first.model).toBe('parent-model');
    expect(first.messages.length).toBe(parentMessages.length + 1);
    expect(first.messages.slice(0, parentMessages.length)).toEqual(parentMessages);
    const appended = first.messages[parentMessages.length];
    expect(appended.role).toBe('user');
    expect(JSON.stringify(appended.content)).toContain('Extract durable memories now.');

    // tool def present in the request (cache-key intact)
    expect((first.tools ?? []).some((t) => t.name === 'Write')).toBe(true);

    // writtenPaths captured from the Write tool_use
    expect(res.writtenPaths).toEqual(['/mem/traits/fav.md']);
    expect(res.terminalReason).toBe('completed');
  });

  test('canUseTool gates execution but keeps the tool in the request (cache preserved)', async () => {
    let dangerRan = false;
    const dangerTool = buildTool({
      name: 'danger',
      isConcurrencySafe: () => true,
      isReadOnly: () => false,
      call: async () => {
        dangerRan = true;
        return { data: 'ran' };
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider, reqs } = recordingProvider([
      [asstToolUse('d1', 'danger', { x: 1 })],
      [asstText('done')],
    ]);

    await runForkedAgent(
      {
        parentMessages,
        model: 'm',
        tools: [dangerTool],
        instruction: 'go',
        canUseTool: (name) => name !== 'danger', // deny danger
      },
      { provider },
    );

    // denied → call never executed
    expect(dangerRan).toBe(false);
    // but the tool definition is still sent to the provider (cache key unchanged)
    expect((reqs[0].tools ?? []).some((t) => t.name === 'danger')).toBe(true);
  });
});
