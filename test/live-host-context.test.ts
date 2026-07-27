import { describe, expect, test } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function tool(name: string, call: () => void): AgentTool {
  return buildTool({
    name,
    inputJSONSchema: {},
    maxResultSizeChars: Infinity,
    call: async () => {
      call();
      return { data: 'ok' };
    },
    mapResult: (data, id) => ({ type: 'tool.result', payload: { callId: id, ok: true, result: data }, ts: 0 }),
  });
}

describe('CoreAgent live host context', () => {
  test('refreshes tools and dynamic context before the next provider call', async () => {
    let discovered = false;
    const search = tool('tool_search', () => { discovered = true; });
    const install = tool('mcp__as-mate-tools__install_packs', () => {});
    const requests: ProviderRequest[] = [];
    let providerCall = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
        requests.push(req);
        if (providerCall++ === 0) {
          yield {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'search-1', name: 'tool_search', input: { query: 'install' } }],
            },
            usage: { ...EMPTY_USAGE },
            stopReason: 'tool_use',
          };
          return;
        }
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          usage: { ...EMPTY_USAGE },
          stopReason: 'end_turn',
        };
      },
    };
    const context: AgentContext = {
      agentId: 'forge',
      provider,
      config: { systemPromptSlots: [], model: 'test', tools: [search], maxTurns: 4 },
      toolContext: {},
    };
    const agent = new CoreAgent({
      context,
      refreshTurnContext: async () => ({
        tools: discovered ? [search, install] : [search],
        dynamicContext: discovered ? '' : '<available-deferred-tools>install</available-deferred-tools>',
      }),
    });

    for await (const _ of agent.run({ input: { type: 'user', payload: 'build', ts: 0 } })) void _;

    expect(requests[0].tools.map((item) => item.name)).toEqual(['tool_search']);
    expect(JSON.stringify(requests[0].messages)).toContain('available-deferred-tools');
    expect(requests[1].tools.map((item) => item.name)).toContain('mcp__as-mate-tools__install_packs');
    expect(JSON.stringify(requests[1].messages)).not.toContain('available-deferred-tools');
  });

  test('refreshes again before a retried provider call', async () => {
    const firstTool = tool('tool_search', () => {});
    const activatedTool = tool('mcp__as-mate-tools__install_packs', () => {});
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
        requests.push(req);
        if (requests.length === 1) throw Object.assign(new Error('temporary'), { status: 500 });
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          usage: { ...EMPTY_USAGE },
          stopReason: 'end_turn',
        };
      },
    };
    let refreshes = 0;
    const context: AgentContext = {
      agentId: 'forge',
      provider,
      config: { systemPromptSlots: [], model: 'test', tools: [firstTool], maxTurns: 2 },
      toolContext: {},
    };
    const agent = new CoreAgent({
      context,
      retry: { maxRetries: 1, sleep: async () => {} },
      refreshTurnContext: async () => {
        refreshes++;
        return { tools: refreshes > 1 ? [firstTool, activatedTool] : [firstTool] };
      },
    });

    for await (const _ of agent.run({ input: { type: 'user', payload: 'build', ts: 0 } })) void _;

    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((item) => item.name)).not.toContain(activatedTool.name);
    expect(requests[1].tools.map((item) => item.name)).toContain(activatedTool.name);
  });
});
