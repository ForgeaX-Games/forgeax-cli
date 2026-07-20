/**
 * F-01 — 反向 MCP server(`forgeax-cli mcp-serve`)。
 *
 * ① hermetic:直接驱动 `handleMcpRequest`——initialize 握手 / tools/list /
 *    tools/call(只读放行、mutating 默认拒)。
 * ② 回环 e2e:用 core 自己的 stdio MCP client(`makeStdioMcpFactory`)spawn 真进程
 *    `bun src/cli/main.ts mcp-serve`,initialize → listTools → callTool 端到端。
 *
 * 「红」= 该子命令在本单前**不存在**(反向 server 缺失,grep 无 MCP server 入口);
 * 本测试是补能力后的绿色回归。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpRequest, type McpServeDeps } from '../src/cli/mcp-serve';
import { parseArgs, buildContext } from '../src/cli/main';
import { normalizeRules } from '../src/permission/rules';
import { makeStdioMcpFactory } from '../src/cli/mcp-stdio';
import { InProcessMCPClient, type MCPToolResult } from '../src/capability/mcp/client';

function makeDeps(allowMutations = false): McpServeDeps {
  const ctx = buildContext(parseArgs(['--demo']));
  return {
    tools: ctx.config.tools,
    toolContext: ctx.toolContext as Record<string, unknown>,
    rules: normalizeRules({}),
    allowMutations,
  };
}

describe('F-01 reverse MCP server — hermetic (handleMcpRequest)', () => {
  test('initialize 握手回报 protocolVersion + serverInfo + tools capability', async () => {
    const res = (await handleMcpRequest('initialize', {}, makeDeps())) as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string };
    };
    expect(res.protocolVersion).toBeTruthy();
    expect(res.serverInfo.name).toBe('forgeax-core');
    expect(res.capabilities.tools).toBeDefined();
  });

  test('tools/list 暴露内置工具(read_file/web_fetch),无后端时不含 web_search', async () => {
    const res = (await handleMcpRequest('tools/list', undefined, makeDeps())) as {
      tools: Array<{ name: string; inputSchema?: unknown }>;
    };
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('web_fetch');
    expect(names).not.toContain('web_search');
    // 每个工具都带 inputSchema(MCP 客户端可据此构造调用)。
    expect(res.tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object')).toBe(true);
  });

  test('tools/call 只读工具(read_file)放行并返回内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-serve-'));
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'FORGEAX_REVERSE_MCP_OK');
    try {
      const res = (await handleMcpRequest(
        'tools/call',
        { name: 'read_file', arguments: { file_path: file } },
        makeDeps(),
      )) as MCPToolResult;
      expect(res.isError).toBeFalsy();
      const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
      expect(text).toContain('FORGEAX_REVERSE_MCP_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tools/call 改动型工具(write_file)默认拒绝,--allow-writes 后放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-serve-'));
    const file = join(dir, 'out.txt');
    try {
      const denied = (await handleMcpRequest(
        'tools/call',
        { name: 'write_file', arguments: { file_path: file, content: 'x' } },
        makeDeps(false),
      )) as MCPToolResult;
      expect(denied.isError).toBe(true);
      expect((denied.content as Array<{ text: string }>)[0].text).toContain('--allow-writes');

      const allowed = (await handleMcpRequest(
        'tools/call',
        { name: 'write_file', arguments: { file_path: file, content: 'x' } },
        makeDeps(true),
      )) as MCPToolResult;
      expect(allowed.isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未知方法 → JSON-RPC method-not-found(-32601)', async () => {
    await expect(handleMcpRequest('does/not/exist', {}, makeDeps())).rejects.toThrow(/method not found/);
  });

  test('未知工具 → -32602', async () => {
    await expect(
      handleMcpRequest('tools/call', { name: 'nope' }, makeDeps()),
    ).rejects.toThrow(/unknown tool/);
  });
});

describe('F-01 reverse MCP server — loopback e2e (core client → core server, real subprocess)', () => {
  test('spawn mcp-serve,经 core stdio client 跑 initialize + tools/list + tools/call', async () => {
    const factory = makeStdioMcpFactory();
    const client = (await factory('core-loopback', {
      type: 'stdio',
      command: 'bun',
      args: [join(import.meta.dir, '..', 'src', 'cli', 'main.ts'), 'mcp-serve', '--demo'],
    })) as InProcessMCPClient;
    const dir = mkdtempSync(join(tmpdir(), 'mcp-serve-e2e-'));
    const file = join(dir, 'loop.txt');
    writeFileSync(file, 'LOOPBACK_ROUNDTRIP_OK');
    try {
      const init = await client.initialize!();
      expect(init.serverInfo?.name).toBe('forgeax-core');

      const tools = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('web_search');

      const result = await client.callTool('read_file', { file_path: file });
      const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('');
      expect(text).toContain('LOOPBACK_ROUNDTRIP_OK');
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
