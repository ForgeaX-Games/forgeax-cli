/**
 * host-tools-for-agent —— 纯函数:给定 (sid, agentId),算出该 agent **应当**看到的
 * host 工具(插件 `provides.tools` 里 exposedToAI + 有 handler + 命中 agent.json 的
 * host-tools allow)映射成中立 ToolSpec。
 *
 * 为什么需要它:conscious-agent(forgeax-native)路径经 kits `host_tool_bridge` 把这些
 * 工具注册进 agent 的 tool registry,再由 conscious-agent 取出当 extraTools 下发内核。
 * 但 **`/api/cli/chat`(租用内核 cbc/cc/codex 的聊天入口)不经 conscious-agent**,
 * 之前 composeTurnRequest 完全不带 agent host-tools → 插件工具(team + gen3d 等)
 * 对租用内核**不可见**。本 helper 让 cli/chat 用与桥**同一套** allow 过滤规则,无需
 * 一个活着的 conscious agent 就能算出该下发哪些 host 工具。
 *
 * 与 `host_tool_bridge.ts` 的 desiredTools()/toInputSchema()/globToRegExp() 同规则
 * (故意保持一致);差别只是数据源:桥读 AgentContext.getAgentJson(),这里从磁盘读
 * `<sid>/agents/<agentId>/agent.json`。LLM 可见名同样把 `:`/`.` → `_`。
 */
import { readFileSync } from 'node:fs';
import { listTools } from '../../tools/registry';
import { getPathManager } from '../../fs/path-manager';

export interface HostToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function globToRegExp(token: string): RegExp {
  const escaped = token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** ToolDescriptor.argsSchema(内联对象 或 schema 文件绝对路径)→ JSONSchema 对象。 */
function toInputSchema(argsSchema: unknown): Record<string, unknown> {
  let schema: unknown = argsSchema;
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(readFileSync(schema, 'utf-8'));
    } catch {
      schema = undefined;
    }
  }
  if (schema && typeof schema === 'object') {
    const s = schema as Record<string, unknown>;
    if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
      return {
        type: 'object',
        properties: s.properties as Record<string, unknown>,
        ...(Array.isArray(s.required) ? { required: s.required } : {}),
      };
    }
  }
  return { type: 'object', properties: {} };
}

interface AgentJsonShape {
  kits?: { config?: { ['host-tools']?: { allow?: unknown; deny?: unknown } } };
}

function readAgentAllowDeny(sid: string | undefined, agentId: string): { allow: string[]; deny: string[] } {
  if (!sid) return { allow: [], deny: [] };
  try {
    const p = getPathManager().session(sid).agent(agentId).agentJson();
    const j = JSON.parse(readFileSync(p, 'utf-8')) as AgentJsonShape;
    const cfg = j.kits?.config?.['host-tools'] ?? {};
    const allow = Array.isArray(cfg.allow) ? cfg.allow.filter((x): x is string => typeof x === 'string') : [];
    const deny = Array.isArray(cfg.deny) ? cfg.deny.filter((x): x is string => typeof x === 'string') : [];
    return { allow, deny };
  } catch {
    return { allow: [], deny: [] };
  }
}

/** 该 agent 应下发给内核的 host 工具(ToolSpec)。allow 为空 → 空集(opt-in 缺省)。 */
export function hostToolSpecsForAgent(sid: string | undefined, agentId: string): HostToolSpec[] {
  const { allow, deny } = readAgentAllowDeny(sid, agentId);
  if (allow.length === 0) return [];
  const allowRes = allow.map(globToRegExp);
  const denyRes = deny.map(globToRegExp);
  let descriptors;
  try {
    descriptors = listTools();
  } catch {
    return [];
  }
  return descriptors
    .filter(
      (d) =>
        d.exposedToAI &&
        d.hasHandler &&
        allowRes.some((re) => re.test(d.id)) &&
        !denyRes.some((re) => re.test(d.id)),
    )
    .map((d) => ({
      name: d.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      description: d.description ?? d.id,
      inputSchema: toInputSchema(d.argsSchema),
    }));
}
