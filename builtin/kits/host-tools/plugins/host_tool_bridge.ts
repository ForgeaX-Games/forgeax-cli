/** host_tool_bridge — the missing `composeToolset` bridge.
 *
 *  设计意图（docs/v2-vision/.../03-AGENT-SKILL-PLUGIN-TRINITY.md）：
 *  插件在 forgeax-plugin.json 的 `provides.tools[]` 里声明的工具（带
 *  `exposedToAI: true`）应当**自动**进入 agent 的 LLM 工具清单，由 LLM 通过
 *  对话自由调用 —— 无需每个 workbench 团队手写一份 builtin/kits/<x> 的 HTTP 桥。
 *
 *  此前这个桥从未落地：LLM 只能看到 Kit ToolRegistry（builtin/kits 下的 tools）里的
 *  工具，Host ToolRegistry（清单声明 + /api/tools/call）里的工具对 LLM 不可见。
 *  各团队（narrative / character-forge）只能手抄一份 kit 工具当“DVD”绕过。
 *
 *  本插件就是那台“机顶盒”：作为 `plugins` kind 在 tools kind 之前加载，于
 *  `start()` 时枚举 Host 侧 `listTools()`，按 agent 的 allow/deny 白名单筛出
 *  `exposedToAI` 工具，桥接成标准 `ToolDefinition` 动态 register 进 agent 的
 *  tools registry —— 之后 ConsciousAgent.getTools()=toolRegistry.list() 自然
 *  带上它们，喂给 LLM。execute 时以 caller.kind='ai' 转调 Host `callTool`，
 *  复用宿主侧的权限门（exposedToAI / requireConfirm 二次确认 / pause 等）。
 *
 *  配置（agent.json `kits.config['host-tools']`）：
 *    { allow?: string[]; deny?: string[] }   // glob，匹配 Host toolId（如 "narrative:*"）
 *  缺省 **opt-in / deny-all**：allow=[] —— 即一个 agent 默认不注入任何宿主工具，
 *  只有在其 manifest 的 `provides.agent.tools[]`（经 sessions 注入到 agent.json
 *  `kits.config['host-tools'].allow`）显式声明后才注入对应工具。这样避免把全平台
 *  几十个 exposedToAI 工具一股脑堆给每个 agent，让“哪个角色能调哪些 workbench
 *  能力”成为可审计的显式声明（符合 03-TRINITY 的 per-agent composeToolset 意图）。 */

import { readFileSync } from "node:fs";
import type { AgentContext, ToolDefinition } from "../../../../src/core/types";
import type { PluginSource } from "../../../../src/kits/types";
import { listTools, callTool, type ToolDescriptor } from "../../../../src/tools/registry";

/** 迁移护栏：这些前缀的 Host 工具仍由各自的 legacy builtin kit 提供（bare 名），
 *  默认 deny 以免“桥接版 + kit 版”双份列给 LLM 造成混淆。等对应 kit 退役后，
 *  从这里移除前缀即可让其走桥。narrative 与 character 均已退役(character 业务
 *  2026-06 迁入 wb-character 插件,builtin/kits/character-forge 已删),故此处为空。 */
const LEGACY_KIT_PLUGIN_GUARDS: string[] = [];

interface HostToolsConfig {
  allow?: string[];
  deny?: string[];
}

/** 把 glob token（仅支持 `*` 通配）编译成锚定正则。`*` → `.*`，其余字面转义。 */
function globToRegExp(token: string): RegExp {
  const escaped = token.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(toolId: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(toolId));
}

/** ToolDescriptor.argsSchema → ToolDefinition.input_schema。
 *  argsSchema 有两种形态(见 plugins/kinds/tool.ts:normalizeSchemaRef):
 *    - 内联 JSONSchema 对象 → 直接用
 *    - 绝对路径字符串(清单写 "./schemas/x.args.json",加载器只解析路径不读盘)
 *      → 这里读盘 + JSON.parse 取回真实 schema
 *  容错:缺失/读不到/非 object schema 时退化成空 object,保证 LLM 拿到合法 schema。 */
function toInputSchema(argsSchema: unknown): ToolDefinition["input_schema"] {
  let schema: unknown = argsSchema;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(readFileSync(schema, "utf-8"));
    } catch {
      schema = undefined;
    }
  }
  if (schema && typeof schema === "object") {
    const s = schema as Record<string, unknown>;
    if (s.type === "object" && s.properties && typeof s.properties === "object") {
      return {
        type: "object",
        properties: s.properties as Record<string, unknown>,
        required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
      };
    }
  }
  return { type: "object", properties: {} };
}

/** 从 agentDir 抽 sessionId（`<root>/sessions/<sid>/...`）。抽不到则返回 undefined
 *  —— caller.sessionId 是可选的，仅用于 ledger / 事件归类。 */
function sessionIdFromDir(agentDir: string): string | undefined {
  const m = agentDir.match(/\/sessions\/([^/]+)\//);
  return m ? m[1] : undefined;
}

/** 把单个 Host 工具描述符桥接成标准 ToolDefinition。 */
function bridgeTool(d: ToolDescriptor, ctx: AgentContext): ToolDefinition {
  const sessionId = sessionIdFromDir(ctx.agentDir);
  return {
    // LLM tool-name 受 Anthropic/OpenAI 约束 `^[a-zA-Z0-9_-]{1,128}$`：':' 和 '.'
    // 都非法（toolId 如 "lowpoly:pipeline.applyBatch" 含两者）。把非法字符映射成
    // '_' 喂给 LLM；execute 闭包里仍用原始 d.id 调 callTool，无需反查映射。
    name: d.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    description: d.description ?? d.id,
    input_schema: toInputSchema(d.argsSchema),
    async execute(args) {
      const res = await callTool({
        toolId: d.id,
        args,
        caller: { kind: "ai", agentId: ctx.agentPath, sessionId },
      });
      if (res.ok) {
        return typeof res.result === "string"
          ? res.result
          : JSON.stringify(res.result, null, 2);
      }
      return JSON.stringify({ error: res.error, code: res.code });
    },
  };
}

export default function hostToolBridge(ctx: AgentContext): PluginSource {
  /** 已桥接的 key（`hosttool:<id>`）。用 Set 便于幂等 diff（增量 register / release）。
   *  键类型与 `want`（`as const` 推出的 `hosttool:${string}`）保持一致，避免 `want.has(key)` 宽窄不匹配。 */
  const registeredKeys = new Set<`hosttool:${string}`>();
  /** 上轮同步出的目标键签名；未变则短路，避免 per-event 反复改注册表。 */
  let lastSig = "\0";
  /** 事件总线退订句柄；stop() 时调用。 */
  let unobserve: (() => void) | null = null;
  let stopped = false;

  function resolveConfig(): { allow: RegExp[]; deny: RegExp[] } {
    const cfg = (ctx.getAgentJson().kits?.config?.["host-tools"] ?? {}) as HostToolsConfig;
    const allowTokens = cfg.allow ?? [];
    const denyTokens = [...(cfg.deny ?? []), ...LEGACY_KIT_PLUGIN_GUARDS];
    return {
      allow: allowTokens.map(globToRegExp),
      deny: denyTokens.map(globToRegExp),
    };
  }

  /** 当前**应当**桥接的 Host 工具集：exposedToAI + 有 handler + 命中 allow 且未被 deny。
   *  allow 为空（opt-in 缺省）→ 空集；listTools 抛错（快照未就绪等）→ 安全退化空集。 */
  function desiredTools(): ToolDescriptor[] {
    const { allow, deny } = resolveConfig();
    if (allow.length === 0) return [];
    let descriptors: ToolDescriptor[];
    try {
      descriptors = listTools();
    } catch (err: unknown) {
      process.stderr.write(
        `[host_tool_bridge] listTools failed: ${(err as Error)?.message ?? err}\n`,
      );
      return [];
    }
    return descriptors.filter(
      (d) => d.exposedToAI && d.hasHandler && matchesAny(d.id, allow) && !matchesAny(d.id, deny),
    );
  }

  /** 幂等对齐：目标集 vs 已注册集做增量 diff —— 补注缺失的、释放已消失的。
   *
   *  这是修掉"重启脆弱点"的核心：插件 start() 只跑一次，无法覆盖
   *    (a) agent 启动早于宿主插件快照就绪（重启竞态 → 枚举到空 → 整会话无工具），
   *    (b) 运行中 /api/plugins/reload 让宿主工具增减。
   *  改为每轮事件幂等重对齐（sig 未变即短路，不碰注册表），让工具表自愈。 */
  function sync(): void {
    if (stopped) return;
    const want = new Map(desiredTools().map((d) => [`hosttool:${d.id}`, d] as const));
    const sig = [...want.keys()].sort().join("|");
    if (sig === lastSig) return; // 目标集未变 → 快速短路（per-event 热路径）
    lastSig = sig;
    for (const [key, d] of want) {
      if (!registeredKeys.has(key)) {
        ctx.tools.register(key, bridgeTool(d, ctx));
        registeredKeys.add(key);
      }
    }
    for (const key of [...registeredKeys]) {
      if (!want.has(key)) {
        ctx.tools.release(key);
        registeredKeys.delete(key);
      }
    }
  }

  return {
    name: "host_tool_bridge",
    description:
      "Bridges plugin-manifest-declared Host tools (exposedToAI) into this agent's LLM tool list.",
    condition() {
      return true;
    },
    start() {
      sync(); // 启动即尝试（快照已就绪时一次到位）
      // 重入点：订阅事件总线，在每轮事件后幂等重对齐。sig 未变时为 O(1) 短路，
      // 仅在"快照后就绪 / reload 增减"时真正改注册表。observer 自身吞异常，
      // 绝不污染事件总线。
      unobserve = ctx.eventBus.observe(() => {
        try {
          sync();
        } catch (err: unknown) {
          process.stderr.write(
            `[host_tool_bridge] sync failed: ${(err as Error)?.message ?? err}\n`,
          );
        }
      });
    },
    stop() {
      stopped = true;
      unobserve?.();
      unobserve = null;
      for (const key of registeredKeys) ctx.tools.release(key);
      registeredKeys.clear();
      lastSig = "\0";
    },
  };
}
