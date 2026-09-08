import { describe, expect, test } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function tool(
  name: string,
  call: () => void,
  options: { description?: string; inputJSONSchema?: Record<string, unknown> } = {},
): AgentTool {
  return buildTool({
    name,
    description: options.description,
    inputJSONSchema: options.inputJSONSchema ?? {},
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
    expect(requests[0].skipCacheWrite).toBe(true);
    expect(requests[1].tools.map((item) => item.name)).toContain('mcp__as-mate-tools__install_packs');
    expect(JSON.stringify(requests[1].messages)).not.toContain('available-deferred-tools');
    expect(requests[1].skipCacheWrite).toBeUndefined();
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
        return {
          tools: refreshes > 1 ? [firstTool, activatedTool] : [firstTool],
          dynamicContext: `<scratchpad_path>/sessions/${refreshes}/scratchpad</scratchpad_path>`,
        };
      },
    });

    for await (const _ of agent.run({ input: { type: 'user', payload: 'build', ts: 0 } })) void _;

    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((item) => item.name)).not.toContain(activatedTool.name);
    expect(requests[1].tools.map((item) => item.name)).toContain(activatedTool.name);
    expect(requests.every((request) => request.skipCacheWrite === true)).toBe(true);
  });

  test('deduplicates duplicate live tool definitions while keeping the first definition', async () => {
    const installName = 'mcp__as-mate-tools__install_packs';
    const writeName = 'mcp__as-mate-tools__write_file';
    const firstInstallSchema = { type: 'object', properties: { source: { type: 'string' } } };
    const secondInstallSchema = { type: 'object', properties: { package: { type: 'string' } } };
    const firstWriteSchema = { type: 'object', properties: { path: { type: 'string' } } };
    const secondWriteSchema = { type: 'object', properties: { file: { type: 'string' } } };
    const calls: string[] = [];
    const firstInstall = tool(installName, () => calls.push('install:first'), {
      description: 'first install definition',
      inputJSONSchema: firstInstallSchema,
    });
    const secondInstall = tool(installName, () => calls.push('install:second'), {
      description: 'second install definition',
      inputJSONSchema: secondInstallSchema,
    });
    const firstWrite = tool(writeName, () => calls.push('write:first'), {
      description: 'first write definition',
      inputJSONSchema: firstWriteSchema,
    });
    const secondWrite = tool(writeName, () => calls.push('write:second'), {
      description: 'second write definition',
      inputJSONSchema: secondWriteSchema,
    });
    const distinct = tool('distinct_tool', () => calls.push('distinct'));
    const roster = [firstInstall, secondInstall, firstWrite, secondWrite, distinct];
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
        requests.push(req);
        if (requests.length === 1) throw Object.assign(new Error('temporary'), { status: 500 });
        if (requests.length === 2) {
          yield {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'install-1', name: installName, input: {} },
                { type: 'tool_use', id: 'write-1', name: writeName, input: {} },
              ],
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
    let refreshes = 0;
    const context: AgentContext = {
      agentId: 'forge',
      provider,
      config: { systemPromptSlots: [], model: 'test', tools: roster, maxTurns: 3 },
      toolContext: {},
    };
    const agent = new CoreAgent({
      context,
      retry: { maxRetries: 1, sleep: async () => {} },
      refreshTurnContext: async () => {
        refreshes++;
        return refreshes === 1 ? { dynamicContext: '' } : { tools: roster };
      },
    });

    for await (const _ of agent.run({ input: { type: 'user', payload: 'build', ts: 0 } })) void _;

    expect(refreshes).toBe(3);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.tools.map((item) => item.name)).toEqual([installName, writeName, 'distinct_tool']);
      expect(new Set(request.tools.map((item) => item.name)).size).toBe(request.tools.length);
    }
    expect(requests[0].tools.find((item) => item.name === installName)).toMatchObject({
      description: 'first install definition',
      inputSchema: firstInstallSchema,
    });
    expect(requests[0].tools.find((item) => item.name === writeName)).toMatchObject({
      description: 'first write definition',
      inputSchema: firstWriteSchema,
    });
    expect(calls).toEqual(['install:first', 'write:first']);
  });
});
