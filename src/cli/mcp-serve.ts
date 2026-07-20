/**
 * forgeax-core `mcp-serve` —— 反向 MCP server(F-01)。
 *
 * 把 core 装配好的工具集以 **stdio MCP server** 形态暴露:任意 MCP 客户端
 * (Cursor / Zed / Claude Desktop / 另一个 agent)可 `initialize` 握手 → `tools/list`
 * → `tools/call` 把 forgeax-core 内置工具当后端用。与 `--serve` 的 AgentKernel
 * JSON-RPC sidecar 并存:sidecar 面向 agent-host 宿主(自有协议、unix sock),
 * mcp-serve 面向外部 MCP 生态(stdio、标准 MCP)。
 *
 * 协议:手写 newline-framed JSON-RPC(每条消息一行 `JSON.stringify(msg)+"\n"`,
 * 对齐 `cli/mcp-stdio.ts` 的 client 帧格式与 MCP stdio transport spec)——**不引
 * 外部 MCP SDK**(与 `FetchMCPClient`/`InProcessMCPClient` 同路线自实现,boundary 不破)。
 *
 * 信任边界:每次 `tools/call` 都过现有权限引擎(`hasPermissionsToUseTool`,读
 * settings.permissions 规则)。server 非交互——`ask` 一律拒绝;**改动型工具默认
 * 不放行**(只读工具开箱可用,mutating 工具需 `--allow-writes` / `FORGEAX_MCP_ALLOW_WRITES=1`
 * 显式开启),对齐「危险工具默认 deny」。
 *
 * Boundary: HOST 层(src/cli/),仅 import core-local 相对 + node:。
 */
import type { AgentTool, ToolContext } from '../capability/types';
import type { PermissionRuleSet } from '../permission/rules';
import { hasPermissionsToUseTool, safeReadOnly } from '../permission/engine';
import { MCP_PROTOCOL_VERSION, type MCPTool, type MCPToolResult } from '../capability/mcp/client';
import { FORGEAX_CORE_VERSION } from '../version';

/** mcp-serve 处理一条请求所需的装配依赖(纯,供测试直接驱动)。 */
export interface McpServeDeps {
  tools: readonly AgentTool[];
  /** 工具执行环境(sandboxFs/terminal/cwd/...);signal 每次调用现补。 */
  toolContext: Record<string, unknown>;
  /** settings.permissions 载出的规则集(deny 恒强制)。 */
  rules: PermissionRuleSet;
  /** 是否放行改动型工具(--allow-writes / env)。默认 false → 只读工具可用,其余拒绝。 */
  allowMutations: boolean;
}

const SERVER_INFO = { name: 'forgeax-core', version: FORGEAX_CORE_VERSION } as const;

/** 带 JSON-RPC error code 的错误(runMcpServe 据 `.code` 包 error 帧)。 */
class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** AgentTool → MCP `tools/list` 描述(缺 JSON Schema 时给宽松 object)。 */
function toMcpTool(t: AgentTool): MCPTool {
  return {
    name: t.name,
    description: t.description ?? t.searchHint,
    inputSchema: (t.inputJSONSchema as Record<string, unknown>) ?? { type: 'object', additionalProperties: true },
  };
}

/** MCP 工具错误结果(isError,非 JSON-RPC 协议错误)。 */
function toolError(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * 处理一条 MCP JSON-RPC **请求**(带 id 的方法)。返回 result 载荷;协议级错误
 * 抛 RpcError(如未知方法 / 未知工具)。工具级错误(权限拒绝 / call 抛错)以
 * `isError:true` 的 result 返回(对齐 MCP:tool error 走 result,不走 error 帧)。
 */
export async function handleMcpRequest(
  method: string,
  params: unknown,
  deps: McpServeDeps,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: deps.tools.map(toMcpTool) };
    case 'tools/call':
      return callTool(params as { name?: string; arguments?: unknown }, deps);
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

async function callTool(
  params: { name?: string; arguments?: unknown },
  deps: McpServeDeps,
): Promise<MCPToolResult> {
  const name = params?.name;
  if (typeof name !== 'string') throw new RpcError(-32602, 'tools/call requires string "name"');
  const tool = deps.tools.find((t) => t.name === name || t.aliases?.includes(name));
  if (!tool) throw new RpcError(-32602, `unknown tool: ${name}`);

  const input = (params.arguments ?? {}) as unknown;
  const ac = new AbortController();
  // 每次调用唯一 toolUseId(并发 tools/call 不撞;下游按 id 关联权限/审计)。
  const ctx = { ...deps.toolContext, signal: ac.signal, toolUseId: `mcp-serve:${name}:${++callSeq}` } as unknown as ToolContext;

  // 权限闸:deny 恒拒;非只读工具默认拒(需 --allow-writes);ask 非交互一律拒。
  const perm = await hasPermissionsToUseTool(tool, input, ctx, deps.rules);
  if (perm.behavior === 'deny') return toolError(perm.message ?? `denied by permission policy: ${name}`);
  const readOnly = safeReadOnly(tool, input);
  if (!readOnly && !deps.allowMutations) {
    return toolError(`tool "${name}" mutates state; start mcp-serve with --allow-writes to enable it`);
  }
  if (perm.behavior === 'ask' && !deps.allowMutations) {
    return toolError(`tool "${name}" requires interactive approval; unavailable over non-interactive MCP`);
  }

  const finalInput = (perm.updatedInput as unknown) ?? input;
  try {
    const result = await tool.call(finalInput, ctx);
    const data = result.data;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      content: [{ type: 'text', text }],
      ...(data !== null && typeof data === 'object' ? { structuredContent: data } : {}),
    };
  } catch (e) {
    return toolError(`tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 给工具一个真正的取消边界(调用结束即 abort,释放监听 signal 的资源)。
    ac.abort();
  }
}

/** 单调调用序号(toolUseId 唯一化,避免并发 tools/call 撞 id)。 */
let callSeq = 0;

/**
 * stdio MCP server 事件循环:给定装配好的 deps,在 stdin/stdout 上跑 newline-framed
 * JSON-RPC,常驻直到 stdin 关闭。工具集装配由 host 入口(cli/main.ts)完成后传入
 * ——本模块只管协议 + 循环,不反向依赖 main(避免 host 入口 ↔ 本模块循环依赖)。
 */
export async function runMcpServe(deps: McpServeDeps): Promise<number> {
  const send = (obj: unknown): void => void process.stdout.write(JSON.stringify(obj) + '\n');

  const onLine = async (line: string): Promise<void> => {
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 坏帧忽略(不毒化流)
    }
    const { id, method, params } = msg;
    if (typeof method !== 'string') return; // response / 垃圾帧
    if (id === undefined || id === null) return; // 通知(如 notifications/initialized)——不回
    try {
      const result = await handleMcpRequest(method, params, deps);
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      send({ jsonrpc: '2.0', id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void onLine(line);
      }
    });
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
  return 0;
}
