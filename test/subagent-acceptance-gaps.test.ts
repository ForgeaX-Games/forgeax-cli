/**
 * 验收补测(23-子agent调度):给此前靠源码精读判过的 3 点补执行级证据。
 *   - 23.8  StructuredOutput 透回:非法提交→回灌重试(structured 不写);合法→structured=最后合法 payload;无 schema→undefined。
 *   - 23.46 rules 透传子 loop:deny 规则真的在子 loop 的 dispatch 上生效(子拿不到被 deny 的工具 body)。
 *   - 23.23 畸形 agent 文件不冒泡:坏文件被跳过、好文件照常加载,loadAgentDefs 不抛。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagent } from '../src/agent/subagent';
import { loadAgentDefs } from '../src/capability/agent/loader';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, usage: EMPTY_USAGE as Usage, stopReason: 'tool_use' };
}
function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return { api: 'stub', async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const e of t) yield e; } };
}

// ─── 23.8 StructuredOutput 透回 ───────────────────────────────────────────────
describe('23.8 StructuredOutput 透回(subagent 语境)', () => {
  const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } as const;

  test('非法提交→回灌重试(structured 不写),合法提交→structured=最后合法 payload', async () => {
    // 轮1:提交非法(answer 是 string,不合 schema)→ tool 回 isError,structured 不写。
    // 轮2:提交合法 → onValid 捕获。 轮3:收尾文本。
    const provider = scripted([
      [asstToolUse('s1', 'StructuredOutput', { answer: 'not-a-number' })],
      [asstToolUse('s2', 'StructuredOutput', { answer: 42 })],
      [asstText('done')],
    ]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [], schema: schema as never }, { provider });
    expect(r.structured).toEqual({ answer: 42 }); // 最后一次合法 payload
    expect(r.terminalReason).toBe('completed');
  });

  test('只提交非法 → structured 留 undefined(未有合法提交)', async () => {
    const provider = scripted([
      [asstToolUse('s1', 'StructuredOutput', { answer: 'bad' })],
      [asstText('gave up')],
    ]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [], schema: schema as never }, { provider });
    expect(r.structured).toBeUndefined();
  });

  test('未给 schema → structured 恒 undefined(零回归)', async () => {
    const provider = scripted([[asstText('plain')]]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [] }, { provider });
    expect(r.structured).toBeUndefined();
  });
});

// ─── 23.46 rules 透传子 loop ─────────────────────────────────────────────────
describe('23.46 rules 透传子 loop(deny 规则在子 dispatch 生效)', () => {
  function sideEffectEcho(): { tool: AgentTool; ran: () => number } {
    let calls = 0;
    const tool = buildTool({
      name: 'echo', isConcurrencySafe: () => true, isReadOnly: () => true,
      call: async (i: unknown) => { calls++; return { data: i }; },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 1000,
    });
    return { tool, ran: () => calls };
  }

  test('无 rules → 子正常调用 echo body(基线)', async () => {
    const { tool, ran } = sideEffectEcho();
    const provider = scripted([[asstToolUse('t1', 'echo', { v: 1 })], [asstText('ok')]]);
    await runSubagent({ input: 'x', model: 'm', tools: [tool] }, { provider });
    expect(ran()).toBe(1);
  });

  test('deny 规则 → 子 dispatch 拦下 echo,body 不执行(证明 rules 透传到子 loop)', async () => {
    const { tool, ran } = sideEffectEcho();
    const provider = scripted([[asstToolUse('t1', 'echo', { v: 1 })], [asstText('ok')]]);
    const r = await runSubagent(
      { input: 'x', model: 'm', tools: [tool] },
      { provider, rules: { deny: [{ toolName: 'echo', behavior: 'deny' }] } },
    );
    expect(ran()).toBe(0); // 被 deny,body 从未执行 → rules 确实作用在子 loop 上
    expect(r.terminalReason).toBe('completed'); // 子仍正常收尾
  });
});

// ─── 23.23 畸形 agent 文件不冒泡 ─────────────────────────────────────────────
describe('23.23 畸形 agent 文件不冒泡', () => {
  test('坏文件跳过、好文件加载,loadAgentDefs 不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeax-agentdir-'));
    // 好:完整 frontmatter。
    writeFileSync(join(dir, 'good.md'), '---\nname: good\ndescription: a good agent\n---\nbody');
    // 坏:缺 name/description(loadOne → null,被跳过,不冒泡)。
    writeFileSync(join(dir, 'bad.md'), 'no frontmatter at all, totally malformed :::');
    // 坏:frontmatter 有但缺 description。
    writeFileSync(join(dir, 'partial.md'), '---\nname: partial\n---\nbody');

    let defs: ReturnType<typeof loadAgentDefs> = [];
    expect(() => { defs = loadAgentDefs([dir]); }).not.toThrow(); // 绝不冒泡
    expect(defs.map((d) => d.name)).toEqual(['good']); // 只有好文件进来
  });
});
