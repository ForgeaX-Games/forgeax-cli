/**
 * Regression (P2) — 装配期每个 MCP server 恰好一次 `tools/list`。
 *
 * 曾经:`assembleCapabilities` 两遍装配 —— pass1 `client.listTools()` 仅取工具数做
 * `decideMcpDeferMode` 阈值裁决后丢弃,pass2 `mcpPack→getMcpTools` 对同一 live client
 * 再 `listTools()` 一次。connects===1(client 复用,符合 26.83 口径),但 lists===2:
 * 每个 server 多一次 round-trip,对慢/远端 server 是净浪费。
 *
 * 修复:pass1 的 tools 数组透传给 pass2(`prefetchedTools`),pass2 不再二次 list。
 * 本测试用计数 fake client 钉住:装配后每 server listTools 调用次数 === 1(连接次数 === 1)。
 *
 * Boundary: test 层。
 */
import { test, expect, describe } from 'bun:test';
import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';
import type {
  MCPClient,
  MCPTool,
  MCPToolResult,
  MCPCallOptions,
} from '../src/capability/mcp/client';
import type { ResolveMcpDeps } from '../src/capability/mcp/index';

/** 计数 fake client:每次 listTools 自增 lists。 */
class CountingMCPClient implements MCPClient {
  lists = 0;
  constructor(
    readonly serverName: string,
    readonly tools: MCPTool[],
  ) {}
  async listTools(): Promise<MCPTool[]> {
    this.lists += 1;
    return this.tools;
  }
  async callTool(
    _name: string,
    _args: Record<string, unknown>,
    _opts?: MCPCallOptions,
  ): Promise<MCPToolResult> {
    return { content: 'ok' };
  }
}

function nTools(n: number): MCPTool[] {
  return Array.from({ length: n }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } }));
}

describe('MCP 装配期每 server 单次 tools/list (26.83)', () => {
  test('单 server:装配后 listTools 恰好被调用 1 次', async () => {
    const clients: Record<string, CountingMCPClient> = {};
    const deps: ResolveMcpDeps = {
      sdkFactory: (name) => {
        const c = new CountingMCPClient(name, nTools(3));
        clients[name] = c;
        return c;
      },
    };
    const assembled = await assembleCapabilities({
      bus: new EventBus(),
      mcp: { config: { mcpServers: { srv: { type: 'sdk', name: 'srv' } } }, deps },
    });
    try {
      expect(clients.srv).toBeDefined();
      expect(clients.srv.lists).toBe(1); // 修复前为 2
      // 工具确实装配进来(prefetchedTools 复用未丢工具)。
      expect(assembled.tools.filter((t) => t.name.startsWith('mcp__srv__')).length).toBe(3);
    } finally {
      for (const d of assembled.disposers) await d();
    }
  });

  test('多 server:各自恰好 1 次(client 复用、不重连、不二次 list)', async () => {
    const clients: Record<string, CountingMCPClient> = {};
    let connects = 0;
    const deps: ResolveMcpDeps = {
      sdkFactory: (name) => {
        connects += 1;
        const c = new CountingMCPClient(name, nTools(2));
        clients[name] = c;
        return c;
      },
    };
    const assembled = await assembleCapabilities({
      bus: new EventBus(),
      mcp: {
        config: {
          mcpServers: { a: { type: 'sdk', name: 'a' }, b: { type: 'sdk', name: 'b' } },
        },
        deps,
      },
    });
    try {
      expect(connects).toBe(2); // 每 server 连一次
      expect(clients.a.lists).toBe(1);
      expect(clients.b.lists).toBe(1);
    } finally {
      for (const d of assembled.disposers) await d();
    }
  });
});
