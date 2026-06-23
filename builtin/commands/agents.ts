// @desc Command module: agents — per-session agent 树拓扑（list / get / add / delete）
//
// session 容器 CRUD 走 `/api/sessions/*` REST，**不**进 commands（与 UI TopBar /
// forgeax-bridge 一致，避免双轨）。本模块只管 agent 树拓扑：
//   - list_agents / get_agent  —— 只读
//   - add_agent / delete_agent —— 写盘 + 通过 fs-watcher 让 AgentTree / Scheduler 自动同步
//
// 模型相关命令（get_agent_model / set_agent_models）住隔壁 `commands/models.ts`，
// 因为它们改的是 agent.json::models 字段，归"模型选择"语义而不是"树拓扑"。
//
// args 一律 positional string[]：
//   list_agents     args[0]=sid                                                  hasQuery
//   get_agent       args[0]=sid, args[1]=agentPath                               hasQuery
//   add_agent       args[0]=sid, args[1]=name, args[2]?=agentType                hasExecute
//                   ─ name 单段（不带 "/agents/"），默认创建在 session 顶层
//                   ─ agentType 缺省 "conscious"，可选 "script"
//   delete_agent    args[0]=sid, args[1]=agentPath                               hasExecute
//                   ─ 嵌套子 agent 也接受；rm -rf 时所有子 agent 一并清

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { CommandModule } from "../../src/commands/types";
import {
  ensureAgentScaffold,
  isValidAgentName,
  isValidAgentPath,
  type AgentType,
} from "../../src/core/agent-scaffold";
import { BLACKBOARD_KEYS } from "../../src/defaults/blackboard-vars";

function parseAgentType(name: string, raw: string | undefined): AgentType {
  const t = (raw ?? "conscious").trim().toLowerCase();
  if (t === "conscious" || t === "script") return t;
  throw new Error(`${name}: agentType must be 'conscious' or 'script', got '${raw}'`);
}

const agents: CommandModule = {
  async list() {
    return [
      {
        name: "list_agents",
        description: "session 内全部 agent 节点（args[0]=sid · 含 path/display/depth/fullId/parent/hasLedger/running）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "get_agent",
        description: "单个 agent 详情（args[0]=sid, args[1]=agentPath · 含 running 真值）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "add_agent",
        description:
          "在 session 顶层新建 agent（args[0]=sid, args[1]=name 单段, args[2]?=agentType 缺省 conscious | 可选 script）",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "delete_agent",
        description:
          "删 agent —— scheduler.controlAgent('remove') 停实例 + rm -rf 目录（含子 agent / ledger / blobs / kits override）",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_agents") {
      const sid = (args[0] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      // The frontend polls list_agents on WS connect / active-session switch,
      // and the sid can briefly point at a session that no longer exists (e.g.
      // a stale `forgeax.activeSid` in localStorage). A missing session is not
      // an error here — return an empty roster so AgentsPanel renders its empty
      // state instead of surfacing a 500. (open() throws "session not found".)
      if (!existsSync(ctx.paths.session(sid).configFile())) {
        return { sid, agents: [] };
      }
      const session = await ctx.sm.open(sid);
      // AgentTree.list 返回 depth-asc 顺序，root agent 排第一。
      //   - `hasLedger` —— 该 agent 已经写过持久化 ledger，区分"挂树里但没说话"
      //     vs"真的跑过 turn"。
      //   - `running` —— blackboard.RUNNING 真值快照（ConsciousAgent.process /
      //     executeCommand 进入 turn set true、finally clear false）。前端 ws
      //     连上 / 切 active session 时调 list_agents 顺手拿这个状态，无需
      //     单独 is_agent_running 命令；增量靠 hook:turnStart/turnEnd 事件。
      const list = session.tree.list().map((n) => ({
        path: n.path,
        display: n.display,
        depth: n.depth,
        fullId: n.fullId,
        parent: n.parent ?? null,
        hasLedger: session.ledgers.has(n.path),
        running: session.blackboard.get(n.path, BLACKBOARD_KEYS.RUNNING) === true,
      }));
      return { sid, agents: list };
    }

    if (name === "get_agent") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      const session = await ctx.sm.open(sid);
      const node = session.tree.get(agentPath);
      if (!node) throw new Error(`${name}: agent path not found: ${agentPath}`);
      return {
        sid,
        agent: {
          path: node.path,
          display: node.display,
          depth: node.depth,
          fullId: node.fullId,
          parent: node.parent ?? null,
          children: session.tree.children(node.path).map((c) => c.path),
          hasLedger: session.ledgers.has(node.path),
          running: session.blackboard.get(node.path, BLACKBOARD_KEYS.RUNNING) === true,
        },
      };
    }

    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name === "add_agent") {
      const sid = (args[0] ?? "").trim();
      const agentName = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentName) throw new Error(`${name}: args[1] (name) required`);
      // 顶层入口：限制为单段 name（不含 "/"），强制创建在 `<sid>/agents/<name>/`。
      // 想造子 agent 是另一种语义（`spawn_subagent` 来日实现），故意不在这里复用
      // 同一个命令以免 args 形态发散。
      if (!isValidAgentName(agentName)) {
        throw new Error(
          `${name}: invalid agent name '${agentName}' (must match /^[a-zA-Z0-9_-]+$/ · 单段)`,
        );
      }
      const agentType = parseAgentType(name, args[2]);

      const session = await ctx.sm.open(sid);
      const existed = !!session.tree.get(agentName);

      // ensureAgentScaffold 是 idempotent —— 已存在的 agent.json **不**会被覆盖
      // （保留用户自定义的 model/kits 等）。已存在场景下 add_agent 直接返回
      // created:false，UI 可据此区分"新建"vs"已存在"。
      //
      // 写盘 → FSWatcher 异步派发 rename 事件 → AgentTree.onChange("added") →
      // Scheduler.attachAndStart。response 直接返回，`tree.list()` 立即可见
      // （readdir-only），scheduler 的 attach 在 fs-watcher debounce (300ms)
      // 之后跟上，前端 UI 不依赖 attach 状态。
      const { scaffolded, agentType: scaffoldedType } = await ensureAgentScaffold(
        sid,
        agentName,
        { agentType },
      );

      return {
        sid,
        agentPath: agentName,
        agentType: scaffoldedType,
        // existed=true + scaffolded=false（agent.json 已有）→ created=false
        // existed=true + scaffolded=true （目录在但 agent.json 缺）→ created=true
        // existed=false → 一定 scaffolded=true → created=true
        created: scaffolded || !existed,
      };
    }

    if (name === "delete_agent") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      if (!isValidAgentPath(agentPath)) {
        throw new Error(
          `${name}: invalid agentPath '${agentPath}' (must match name(/agents/name)*)`,
        );
      }

      const session = await ctx.sm.open(sid);
      const existed = !!session.tree.get(agentPath);

      // 先停 agent 实例（fireDetached + agent.shutdown() + agents.delete +
      // onAgentFreed = freeAgentState 清 blackboard/ledger map）。已不在
      // scheduler 里的话 controlAgent 第二次调是安全 noop（doRemove 内
      // if agent 守卫）。子 agent 不在这里逐个 stop —— rm -rf 一锅端走盘，
      // 子 agent 的 scheduler instance 在 session 关闭时一起 shutdown。
      if (existed) {
        try {
          await session.scheduler.controlAgent("remove", agentPath);
        } catch (err) {
          console.warn(
            `[delete_agent] scheduler.controlAgent('remove', '${agentPath}') failed:`,
            (err as Error)?.message ?? err,
          );
        }
      }

      // rm -rf `<sid>/agents/<path>/` —— 一锅端：agent.json / events ledger /
      // blobs / kits override / src（script） / **所有子 agent**。子 agent 也
      // 在物理目录树里（agents/<name>/agents/<sub>/），递归 rm 自然带走。
      // 下次 list_agents 直接 readdirSync 拿不到，无需任何同步等待。
      const root = ctx.paths.session(sid).agent(agentPath).root();
      let removed = false;
      try {
        await rm(root, { recursive: true, force: true });
        removed = true;
      } catch (err) {
        throw new Error(
          `${name}: rm -rf '${root}' failed: ${(err as Error)?.message ?? err}`,
        );
      }

      return {
        sid,
        agentPath,
        existed,
        removed,
      };
    }

    throw new Error(`No execute for: ${name}`);
  },
};

export default agents;
