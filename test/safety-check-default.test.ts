/**
 * E-04 — safetyCheck secure-by-default。
 *
 * CoreAgent 默认(不传 enableSafetyCheck)即开内置受保护路径检查:bypass 模式下写
 * `.forgeax/`/`.git/`/shell-rc 仍被拦(safetyCheck bypass 免疫;无 askUser → fail-closed
 * deny)。显式 `enableSafetyCheck: false` 可 opt-out。用脚本化 fake provider 驱动。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
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
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, usage: EMPTY_USAGE as Usage, stopReason: 'tool_use' };
}
function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
function scriptedProvider(scripts: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return { api: 'stub', async *stream() { const t = scripts[Math.min(call, scripts.length - 1)]; call++; for (const ev of t) yield ev; } };
}
function ctx(tools: AgentTool[], provider: LLMProvider): AgentContext {
  return { agentId: 'a1', provider, config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 8 }, toolContext: {} };
}
async function collect(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'go', ts: 0 } })) out.push(e);
  return out;
}
function firstToolResult(events: AgentEvent[], id: string): Record<string, unknown> | undefined {
  const e = events.find((x) => x.type === 'tool_result' && (x as { toolUseId: string }).toolUseId === id);
  return e ? ((e as { result: { payload: unknown } }).result.payload as Record<string, unknown>) : undefined;
}

describe('E-04 safetyCheck secure-by-default', () => {
  const script = () =>
    scriptedProvider([
      [asstToolUse('w1', 'write_file', { file_path: '.forgeax/settings.json', content: 'x' })],
      [asstText('done')],
    ]);

  test('默认(不传 enableSafetyCheck)+ bypass:写 .forgeax/ 被拦(fail-closed deny)', async () => {
    const agent = new CoreAgent({ context: ctx([writeTool], script()), mode: 'bypassPermissions' });
    const w1 = firstToolResult(await collect(agent), 'w1');
    expect(w1).toBeDefined();
    expect(w1!.isError).toBe(true);
  });

  test('显式 enableSafetyCheck:false + bypass:opt-out,写放行', async () => {
    const agent = new CoreAgent({ context: ctx([writeTool], script()), mode: 'bypassPermissions', enableSafetyCheck: false });
    const w1 = firstToolResult(await collect(agent), 'w1');
    expect(w1).toBeDefined();
    expect(w1!.isError).toBeFalsy();
  });
});
