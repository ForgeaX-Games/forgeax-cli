/**
 * Minimal MCP server protocol shared by CLI-hosted stdio servers.
 *
 * This is transport/dispatch only. Hosts supply live tools and their run
 * functions, keeping permissions and execution policy outside the protocol.
 */

export interface McpServerTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface McpServerSpec {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  tools: readonly McpServerTool[] | (() => Promise<readonly McpServerTool[]> | readonly McpServerTool[]);
  resolveTool?: (name: string, tools: readonly McpServerTool[]) => McpServerTool | undefined;
  onUnknownTool?: (name: string, tools: readonly McpServerTool[]) => Promise<unknown> | unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export function textResult(text: string, isError = false): Record<string, unknown> {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
}

function toToolResult(out: unknown): unknown {
  if (out && typeof out === 'object' && Array.isArray((out as { content?: unknown }).content)) return out;
  if (typeof out === 'string') return textResult(out);
  if (out === undefined) return textResult('');
  return textResult(JSON.stringify(out));
}

async function currentTools(spec: McpServerSpec): Promise<readonly McpServerTool[]> {
  return typeof spec.tools === 'function' ? await spec.tools() : spec.tools;
}

export function createMcpDispatcher(spec: McpServerSpec) {
  return async (msg: JsonRpcMessage): Promise<Record<string, unknown> | null> => {
    const { id, method, params } = msg;
    if (id == null) return null;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: spec.protocolVersion,
          capabilities: spec.capabilities ?? { tools: {} },
          serverInfo: spec.serverInfo,
        },
      };
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (typeof method !== 'string') return null;

    try {
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') {
        const tools = await currentTools(spec);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map(({ name, description = '', inputSchema = { type: 'object' } }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        };
      }
      if (method === 'tools/call') {
        const tools = await currentTools(spec);
        const name = typeof params?.name === 'string' ? params.name : '';
        const tool = spec.resolveTool?.(name, tools) ?? tools.find((candidate) => candidate.name === name);
        if (!tool) {
          if (!spec.onUnknownTool) throw new RpcError(-32602, `unknown tool: ${name}`);
          return { jsonrpc: '2.0', id, result: await spec.onUnknownTool(name, tools) };
        }
        try {
          return {
            jsonrpc: '2.0',
            id,
            result: toToolResult(await tool.run((params?.arguments as Record<string, unknown> | undefined) ?? {})),
          };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return {
            jsonrpc: '2.0',
            id,
            result: textResult(`error: ${error instanceof Error ? error.message : String(error)}`, true),
          };
        }
      }
      throw new RpcError(-32601, `method not found: ${method}`);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
}

export async function serveStdio(
  dispatch: ReturnType<typeof createMcpDispatcher>,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  const send = (response: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      output.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  let buffer = '';
  const inFlight = new Set<Promise<void>>();
  input.setEncoding('utf8');
  await new Promise<void>((resolve) => {
    let inputClosed = false;
    const finishIfDrained = (): void => {
      if (inputClosed && inFlight.size === 0) resolve();
    };
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        const task = dispatch(message)
          .then(async (response) => {
            if (response) await send(response);
          })
          .catch(async (error) => {
            if (message.id != null) {
              await send({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            }
          })
          .finally(() => {
            inFlight.delete(task);
            finishIfDrained();
          });
        inFlight.add(task);
      }
    });
    const onInputClosed = (): void => {
      inputClosed = true;
      finishIfDrained();
    };
    input.once('end', onInputClosed);
    input.once('close', onInputClosed);
  });
}
