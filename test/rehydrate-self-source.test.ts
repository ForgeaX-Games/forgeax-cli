/**
 * D-01 —— 压后重挂(rehydrate)自取最近读文件 + 三 host 接线。
 *
 * 复现:三 host 注入 compactionV2 时都只给 summarize、不给 rehydrate → 出厂压缩后不重挂任何
 * 文件。且 rehydrate 的 recentReadPaths 数据源在 loop 内部 read-tracker,host 拿不到 →
 * 需 loop **自取**。本测试锁:host 只需注入 `rehydrate: { readFile, ... }`(不给 recentReadPaths),
 * loop 用自己的 read-tracker 提供「最近读文件」→ 压缩后把该文件以 `_rehydrated` attachment 重挂。
 *
 * Boundary(test 层):相对 import + Bun。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent, type CompactionV2Options } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { buildTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderMessage, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const SMALL = { contextWindow: 21_000, maxOutputTokens: 1_000 }; // effective 20000, emergency ~18400

/** read_file 工具:只读、返回大内容(把 token 顶过 emergency 水位),路径入 read-tracker。 */
const readFileTool = buildTool({
  name: 'read_file',
  isReadOnly: () => true,
  call: async () => ({ data: {} }),
  mapResult: (_o: unknown, id: string) => ({ type: 'tool.result', payload: { toolUseId: id, result: 'x'.repeat(19_000 * 4) }, ts: 0 }),
  maxResultSizeChars: 1e9,
});

function ctx(provider: LLMProvider): AgentContext {
  return { agentId: 'c1', provider, config: { systemPromptSlots: [], model: 'm', tools: [readFileTool], maxTurns: 5 }, toolContext: {} };
}

/** provider:turn0 调 read_file(/a.ts),之后回文本;记录每次请求的 messages。 */
function readThenText(requests: ProviderMessage[][]): LLMProvider {
  let n = 0;
  return {
    api: 'stub',
    async *stream(req): AsyncIterable<ProviderStreamEvent> {
      requests.push(req.messages);
      if (n++ === 0) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { file_path: '/a.ts' } }] },
          usage: EMPTY_USAGE as Usage,
          stopReason: 'tool_use',
        };
      } else {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
      }
    },
  };
}

function v2(over: Partial<CompactionV2Options>): CompactionV2Options {
  return {
    summarize: async () => '<summary>compacted</summary>',
    modelInfo: SMALL,
    nowFn: () => 1_000_000,
    preMessage: false,
    ...over,
  };
}

async function drain(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'q', ts: 0 } })) out.push(e);
  return out;
}

describe('D-01 rehydrate self-source(loop 自取 read-tracker)', () => {
  test('host 只给 readFile(不给 recentReadPaths)→ 压后仍重挂最近读文件', async () => {
    const requests: ProviderMessage[][] = [];
    const agent = new CoreAgent({
      context: ctx(readThenText(requests)),
      bus: new EventBus(),
      compactionV2: v2({
        // ★ host 侧只注入 readFile + 预算,不提供 recentReadPaths;loop 应自取内部 read-tracker。
        rehydrate: { readFile: async (p: string) => `REHYDRATED-BODY(${p})`, tokenBudget: 25_000, maxFiles: 3 },
      }),
    });
    await drain(agent);

    // 压缩后某次请求的历史里应出现重挂 attachment(文本含重挂标记 + 路径 + 重读正文)。
    const flat = requests.map((ms) => ms.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ')).join('\n');
    expect(flat).toContain('Re-attached after compaction');
    expect(flat).toContain('/a.ts');
    expect(flat).toContain('REHYDRATED-BODY(/a.ts)');
  });
});
