import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool, type ProviderToolClass } from '../src/capability/types';
import { mapMcpToolToAgentTool } from '../src/capability/mcp/bridge';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import { DEFAULT_PROVIDER_TOOL_LIMIT, providerToolClassOf } from '../src/agent/tool-budget';

function tool(
  name: string,
  opts: { providerToolClass?: ProviderToolClass; mcp?: boolean } = {},
): AgentTool {
  return buildTool({
    name,
    ...(opts.mcp
      ? {
          providerToolClass: 'non-builtin',
          isMcp: true,
          mcpInfo: { serverName: 'forgeax-tool-limit-repro', toolName: name },
        }
      : { providerToolClass: opts.providerToolClass ?? 'non-builtin' }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: 'ok' }),
    mapResult: (output, id) => ({ type: 'tool.result', payload: { output, id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

function nativeTool(name: string): AgentTool {
  return buildTool({
    name,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: 'ok' }),
    mapResult: (output, id) => ({ type: 'tool.result', payload: { output, id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

function mcpTool(name: string): AgentTool {
  return tool(name, { mcp: true });
}

function expectProviderWireProjection(request: ProviderRequest): void {
  for (const definition of request.tools) {
    expect(definition).not.toHaveProperty('providerToolClass');
    expect(definition).not.toHaveProperty('isMcp');
    expect(definition).not.toHaveProperty('mcpInfo');
  }
}

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

function context(tools: AgentTool[], provider: LLMProvider): AgentContext {
  return {
    agentId: 'tool-budget-test',
    provider,
    config: { systemPromptSlots: [], model: 'test-model', tools, maxTurns: 1 },
    toolContext: {},
  };
}

async function captureFirstRequest(tools: AgentTool[]): Promise<ProviderRequest> {
  let captured: ProviderRequest | undefined;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(request) {
      captured = request;
      yield asstText('done');
    },
  };

  const agent = new CoreAgent({ context: context(tools, provider) });
  for await (const _event of agent.run({ input: { type: 'user', payload: 'go', ts: 0 } })) {
    // Drain the real CoreAgent loop so the provider request is actually emitted.
  }
  if (!captured) throw new Error('provider request was not captured');
  return captured;
}

describe('CoreAgent provider tool budget', () => {
  test('classification defaults are safe for native, explicit external, and MCP tools', () => {
    expect(providerToolClassOf(nativeTool('native'))).toBe('builtin');
    expect(providerToolClassOf(tool('external'))).toBe('non-builtin');
    const mappedMcpTool = mapMcpToolToAgentTool(
      {
        serverName: 'srv',
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
      },
      'srv',
      { name: 'tool', inputSchema: { type: 'object' } },
    );
    expect(mappedMcpTool.providerToolClass).toBe('non-builtin');
    expect(providerToolClassOf(mappedMcpTool)).toBe('non-builtin');
    expect(providerToolClassOf({})).toBe('non-builtin');
    expect(
      providerToolClassOf(
        buildTool({
          ...nativeTool('contradictory-mcp'),
          isMcp: true,
          mcpInfo: { serverName: 'srv', toolName: 'tool' },
        }),
      ),
    ).toBe('non-builtin');
  });

  test('131 native AgentTools become the first 128 provider tools in the final request', async () => {
    const names = Array.from({ length: 131 }, (_, index) => `tool_${String(index + 1).padStart(3, '0')}`);

    const request = await captureFirstRequest(names.map(nativeTool));
    const sentNames = request.tools.map(({ name }) => name);

    expect(request.tools).toHaveLength(DEFAULT_PROVIDER_TOOL_LIMIT);
    expect(sentNames).toEqual(names.slice(0, DEFAULT_PROVIDER_TOOL_LIMIT));
    expect(sentNames).toContain('tool_128');
    expect(sentNames).not.toContain('tool_129');
  });

  test('few native tools are all retained when MCP tools overflow', async () => {
    const nativeNames = ['native_alpha', 'native_beta', 'native_gamma'];
    const mcpNames = Array.from({ length: 130 }, (_, index) => `mcp_tool_${String(index + 1).padStart(3, '0')}`);
    const source = [
      mcpTool(mcpNames[0]),
      nativeTool(nativeNames[0]),
      ...mcpNames.slice(1, 64).map(mcpTool),
      nativeTool(nativeNames[1]),
      ...mcpNames.slice(64).map(mcpTool),
      nativeTool(nativeNames[2]),
    ];

    const request = await captureFirstRequest(source);
    const sentNames = request.tools.map(({ name }) => name);
    const expectedMcpNames = mcpNames.slice(0, DEFAULT_PROVIDER_TOOL_LIMIT - nativeNames.length);

    expect(request.tools).toHaveLength(DEFAULT_PROVIDER_TOOL_LIMIT);
    expect(sentNames.filter((name) => nativeNames.includes(name))).toEqual(nativeNames);
    expect(sentNames.filter((name) => name.startsWith('mcp_tool_'))).toEqual(expectedMcpNames);
    expect(sentNames).toEqual(
      source
        .map((candidate) => candidate.name)
        .filter((name) => nativeNames.includes(name) || expectedMcpNames.includes(name)),
    );
    expectProviderWireProjection(request);
  });

  test('when native tools alone exceed the budget, only the native tail is trimmed', async () => {
    const nativeNames = Array.from({ length: 131 }, (_, index) => `native_${String(index + 1).padStart(3, '0')}`);
    const mcpNames = ['mcp_after_1', 'mcp_after_2'];

    const request = await captureFirstRequest([
      ...nativeNames.map(nativeTool),
      ...mcpNames.map(mcpTool),
    ]);
    const sentNames = request.tools.map(({ name }) => name);

    expect(request.tools).toHaveLength(DEFAULT_PROVIDER_TOOL_LIMIT);
    expect(sentNames).toEqual(nativeNames.slice(0, DEFAULT_PROVIDER_TOOL_LIMIT));
    expect(sentNames).not.toContain('native_129');
    expect(sentNames).not.toContain(mcpNames[0]);
  });

  test('a toolset at the provider limit is unchanged', async () => {
    const names = Array.from({ length: DEFAULT_PROVIDER_TOOL_LIMIT }, (_, index) => `tool_${index + 1}`);

    const request = await captureFirstRequest(names.map(nativeTool));

    expect(request.tools).toHaveLength(DEFAULT_PROVIDER_TOOL_LIMIT);
    expect(request.tools.map(({ name }) => name)).toEqual(names);
  });

  test('a toolset below the provider limit is unchanged', async () => {
    const source = [mcpTool('mcp_first'), nativeTool('native_middle'), tool('external_last')];

    const request = await captureFirstRequest(source);

    expect(request.tools).toHaveLength(source.length);
    expect(request.tools.map(({ name }) => name)).toEqual(source.map(({ name }) => name));
  });

  test('explicit external overflow keeps every builtin and trims external tail in order', async () => {
    const builtinNames = ['builtin_alpha', 'builtin_beta', 'builtin_gamma'];
    const externalNames = Array.from({ length: 130 }, (_, index) => `external_${String(index + 1).padStart(3, '0')}`);
    const source = [
      tool(externalNames[0]),
      tool(builtinNames[0], { providerToolClass: 'builtin' }),
      ...externalNames.slice(1, 64).map((name) => tool(name)),
      tool(builtinNames[1], { providerToolClass: 'builtin' }),
      ...externalNames.slice(64).map((name) => tool(name)),
      tool(builtinNames[2], { providerToolClass: 'builtin' }),
    ];

    const request = await captureFirstRequest(source);
    const sentNames = request.tools.map(({ name }) => name);

    expect(request.tools).toHaveLength(DEFAULT_PROVIDER_TOOL_LIMIT);
    expect(sentNames.filter((name) => builtinNames.includes(name))).toEqual(builtinNames);
    expect(sentNames.filter((name) => name.startsWith('external_'))).toEqual(externalNames.slice(0, 125));
    expect(sentNames).not.toContain('external_126');
  });
});
