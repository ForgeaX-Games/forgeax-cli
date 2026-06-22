// MCP client using the official @modelcontextprotocol/sdk.
//
// Ported from forgeax-studio/packages/agentic_os/src/infrastructure/mcp/
// (cli-port SPEC STEP 30). Replaces the prior hand-rolled JSON-RPC stdio
// implementation with the canonical SDK so we get:
//   - tested transports (stdio / SSE / streamable HTTP)
//   - proper handshake + ToolListChangedNotification handling
//   - typed CallToolResult schema
//
// Public surface kept stable so capabilities/mcp_bridge/tools/* don't change:
//   getServer(name) → ServerHandle
//   callMcpTool(server, tool, args) → unknown
//   shutdownAllMcp()

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerSpec>;
}

export interface ServerHandle {
  name: string;
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

const handles = new Map<string, ServerHandle>();

function loadMcpConfig(): McpConfig {
  const override = process.env.FORGEAX_MCP_CONFIG;
  if (override && existsSync(override)) {
    return JSON.parse(readFileSync(override, "utf8")) as McpConfig;
  }
  // capabilities/mcp_bridge/lib/mcp-client.ts -> ../../../mcp.config.json
  const candidate = join(import.meta.dirname ?? "", "..", "..", "..", "mcp.config.json");
  if (existsSync(candidate)) {
    return JSON.parse(readFileSync(candidate, "utf8")) as McpConfig;
  }
  return { mcpServers: {} };
}

async function spawnAndConnect(name: string, spec: McpServerSpec): Promise<ServerHandle> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
    cwd: spec.cwd,
  });

  const client = new Client(
    { name: "forgeax-cli", version: "1.2.0-forgeax.1" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const listed = await client.listTools();
  const handle: ServerHandle = {
    name,
    client,
    tools: listed.tools as ServerHandle["tools"],
  };
  return handle;
}

export async function getServer(name: string): Promise<ServerHandle> {
  let h = handles.get(name);
  if (h) return h;
  const cfg = loadMcpConfig();
  const spec = cfg.mcpServers?.[name];
  if (!spec) throw new Error(`mcp.config.json has no server named "${name}"`);
  h = await spawnAndConnect(name, spec);
  handles.set(name, h);
  return h;
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const h = await getServer(server);
  const result = await h.client.callTool(
    { name: tool, arguments: args },
    CallToolResultSchema,
    { timeout: 60_000 },
  );
  return result;
}

export async function shutdownAllMcp(): Promise<void> {
  for (const [name, h] of handles) {
    try {
      await h.client.close();
    } catch {
      /* ignore */
    }
    handles.delete(name);
    void name;
  }
}
