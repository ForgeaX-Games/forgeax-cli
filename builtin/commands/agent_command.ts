// @desc Command module: agent_command —— 通用 "让 agent 立即调一个 tool" 入口
//
// 对齐 agenteam-os-ref `commands/skill-dispatch.ts` / `commands/compact.ts` 的
// 设计模式：UI / CLI 通过 commands transport 暴露 execute 命令，命令体内 publish
// 一个 `agent_command` event 到 session.eventBus —— Session 构造里的
// `_bindAgentCommandRouting` observer 会接住事件并桥到 `scheduler.getAgent(to)
// .queueCommand(toolName, args)`，让目标 ConsciousAgent 把这次调用合成 user-issued
// tool_call event 注入下一 turn 的 LLM 历史。
//
// 跟 builtin/commands/character-forge.ts 那种"直调 handler"命令的本质区别：
//   - 直调命令：业务逻辑就地跑完，事件 emit 给前端，**不进 LLM 历史**
//   - agent_command：发事件让 agent 主动跑，tool_result 走正常 prompt 路径，
//     **进 LLM 历史**——agent 看得到"用户刚让我做了 X"
//
// 两种语义都正当，对应"独立创作" vs "协同创作"两种 UX。caller 按需选。
//
// 命令清单（positional args；复杂数据走 args[N]=JSON.stringify(obj) 约定）：
//   agent_command   args[0]=sid, args[1]=agentPath, args[2]=toolName,
//                   args[3]?=JSON.stringify(toolArgs), args[4]?=reason         hasExecute
//                   ↳ 返回 { ok, queued:true, sid, agentPath, toolName }
//
//   list_agent_tools   args[0]=sid, args[1]=agentPath                          hasQuery
//                   ↳ 返回 { sid, agentPath, tools: [{name, bareName,
//                     description, input_schema, guidance?, requiredKeys?}] }
//                   ↳ 让 UI 发现某 agent 当前能调哪些 tool；同 agent 内 kit
//                     hot-reload 后下一次 query 立刻反映

import type { CommandModule } from "../../src/commands/types";
import type { Event } from "../../src/core/types";
import type { ToolDefinition } from "../../src/core/types";

/** ConsciousAgent.queueCommand 接收 `Record<string, string>`，复杂值约定走
 *  `JSON.stringify`；本函数把 args 字段统一 string 化，但保留对象/数组形态时
 *  整段 stringify（agent 端 tool.execute 会 try-parse）。 */
function stringifyArgs(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = JSON.stringify(v);                // arrays / nested objects
  }
  return out;
}

const agentCommand: CommandModule = {
  async list() {
    return [
      {
        name: "agent_command",
        description:
          "让 agent 立即调一个 tool —— 把调用合成 user-issued tool_call 注入下一 turn 的 LLM 历史。" +
          "args[0]=sid, args[1]=agentPath, args[2]=toolName, args[3]?=JSON.stringify(toolArgs), args[4]?=reason",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "list_agent_tools",
        description:
          "列出 agent 当前可调的 tool 清单（name / bareName / description / input_schema）。" +
          "agent kit hot-reload 后即时反映。args[0]=sid, args[1]=agentPath",
        hasQuery: true,
        hasExecute: false,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_agent_tools") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);

      const session = await ctx.sm.open(sid);
      // BaseAgent.agentContext 是 public readonly field —— ScriptAgent / ConsciousAgent
      // 都暴露同一份 toolRegistry，list() 已经把 visibility/condition wrap 进去。
      const agent = session.scheduler.getAgent(agentPath);
      if (!agent) throw new Error(`${name}: agent not found: ${agentPath}`);

      const tools = ((agent as { agentContext?: { tools?: { list?: () => ToolDefinition[] } } })
        .agentContext?.tools?.list?.() ?? []) as ToolDefinition[];

      return {
        sid,
        agentPath,
        tools: tools.map((t) => ({
          name: t.name,
          bareName: t.name.includes("/") ? t.name.split("/").pop() : t.name,
          description: t.description,
          input_schema: t.input_schema,
          guidance: t.guidance,
          requiredKeys: t.requiredKeys,
        })),
      };
    }

    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name === "agent_command") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      const toolName = (args[2] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      if (!toolName) throw new Error(`${name}: args[2] (toolName) required`);

      let toolArgs: Record<string, string> = {};
      if (args[3]) {
        let raw: unknown;
        try { raw = JSON.parse(args[3]); }
        catch (err) {
          throw new Error(`${name}: args[3] must be valid JSON — ${(err as Error).message}`);
        }
        toolArgs = stringifyArgs(raw);
      }
      const reason = args[4] ? args[4].trim() : undefined;

      const session = await ctx.sm.open(sid);
      // 不使用 event.to —— EventBus.emit 会用 to 走 route() 把事件 push 到 agent
      // queue，跟 queueCommand 路径重复（agent 会同时把 agent_command 当成普通
      // inbound message 跑一遍）。改用 payload.agentId 让 routing observer 单
      // 路径转发，与 ref attachSchedulerListeners 行为对齐。
      const ev: Event = {
        source: "user",
        type: "agent_command",
        payload: { toolName, args: toolArgs, agentId: agentPath, reason },
        ts: Date.now(),
      };
      session.eventBus.publish(ev, "user");

      return { ok: true, queued: true, sid, agentPath, toolName };
    }

    throw new Error(`No execute for: ${name}`);
  },
};

export default agentCommand;
