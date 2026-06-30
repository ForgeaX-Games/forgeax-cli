/** Agent directory scaffolder —— 在 `<sid>/agents/<path>/` 下补全必要的 agent
 *  文件，使其成为 AgentTree 可识别的合法节点。
 *
 *  入口（两条都走同一个 `ensureAgentScaffold`）：
 *  1. **API / 工具 path（create_agent）**：调 `ensureAgentScaffold(sid, path,
 *     { agentType: "conscious" | "script", overrides })`，显式指定类型。
 *  2. **裸 mkdir path**：用户/外部直接 `mkdir <sid>/agents/<path>/`，
 *     AgentTree 的 addDir watcher 见到合法 agent 路径 + 没 agent.json，
 *     回调到 `ensureAgentScaffold(sid, path, {})`，**默认 conscious**。
 *
 *  Scaffold 是 idempotent —— 已存在的文件不动；conscious 只写 `agent.json`，
 *  script 额外写 `src/index.ts`。forgeax 模型下 agent dir 自包含约定：
 *    必含 agent.json + （lazy）events/event-ledger.jsonl + events/blobs/
 *    可选 kits/ override + 子 agent 文件夹（套娃位于 `<self>/agents/<name>/`）
 *  其它（SOUL/PRINCIPLE/MEMORY/.env 等 ref 概念）**不属于 forgeax**。 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPathManager } from "../fs/path-manager";
import { deepMerge } from "../utils/deep-merge";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import type { AgentJson } from "./types";

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type AgentType = "conscious" | "script";

export interface AgentScaffoldOpts {
  /** 缺省 "conscious"。 */
  agentType?: AgentType;
  /** 写到 agent.json 的额外字段，deep-merge 进默认模板，已有文件不覆盖。 */
  overrides?: Partial<AgentJson>;
}

// ─── 校验 ────────────────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Agent 文件夹名（单段，不带 `/`）。 */
export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/** Agent 逻辑路径形如 `name(/agents/name)*`，对应物理路径
 *  `<agentsRoot>/name(/agents/name)*`。每个偶数位是 agent 名，奇数位必须是
 *  字面量 "agents"。空串 / 多余分隔符都拒。 */
export function isValidAgentPath(p: string): boolean {
  if (!p) return false;
  const segs = p.split("/");
  if (segs.length % 2 === 0) return false;
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 0) {
      if (!isValidAgentName(segs[i])) return false;
    } else {
      if (segs[i] !== "agents") return false;
    }
  }
  return true;
}

// ─── 默认 agent.json（script 模式）+ 默认 src/index.ts ───────────────────────

/** ScriptAgent 的 agent.json 默认值 —— 在 AGENT_DEFAULTS 基础上把 kits
 *  全关掉（script 是代码驱动，默认不需要 LLM 工具堆），其它字段沿用。 */
export function scriptAgentDefaults(): AgentJson {
  return deepMerge(
    AGENT_DEFAULTS as unknown as Record<string, unknown>,
    {
      kits: { user: "none", session: "none" },
    },
  ) as unknown as AgentJson;
}

/** ScriptAgent 的 `src/index.ts` 默认骨架 —— 与 ref 同步骤约定：
 *    导出 `start(ctx)` 与 `update(events, ctx)`，由 ScriptAgent.runMain 在
 *    每轮 queue.drain 后调用 update。 */
export function defaultScriptTemplate(): string {
  return `// @desc ScriptAgent entry —— event-driven automation
import type { AgentContext, Event } from "@/core/types";

/** Called once when the agent starts. */
export async function start(ctx: AgentContext): Promise<void> {
  console.log(\`[\${ctx.agentPath}] script-agent started\`);
}

/** Called each time new events arrive. */
export async function update(events: Event[], ctx: AgentContext): Promise<void> {
  for (const ev of events) {
    console.log(\`[\${ctx.agentPath}] event: \${ev.type}\`);
  }
}
`;
}

// ─── Scaffold 主入口 ─────────────────────────────────────────────────────────

/** 在 `<sid>/agents/<path>/` 下补齐 agent 文件（idempotent）。
 *
 *  - 物理路径不存在 → 创建（递归）。
 *  - `agent.json` 不存在 → 写默认模板（conscious 或 script）+ overrides 合并。
 *  - script 模式下 `src/index.ts` 不存在 → 写默认骨架。
 *  - 已存在的文件**不动**（包括 agent.json，所以反复调安全）。
 *
 *  ⚠️ 不要在这里建 events/ledger 或 blobs —— EventLedger.append() 第一次写盘
 *      时自己 mkdir 兜底，scaffold 不抢这条职责（避免 race + 减少冗余 IO）。
 */
export async function ensureAgentScaffold(
  sid: string,
  agentPath: string,
  opts: AgentScaffoldOpts = {},
): Promise<{ scaffolded: boolean; agentType: AgentType }> {
  if (!isValidAgentPath(agentPath)) {
    throw new Error(
      `[agent-scaffold] invalid agent path '${agentPath}' (must match name(/agents/name)*)`,
    );
  }

  const layer = getPathManager().session(sid).agent(agentPath);
  const agentType: AgentType = opts.agentType ?? "conscious";
  let scaffolded = false;

  await mkdir(layer.root(), { recursive: true });

  // 1) agent.json
  if (!existsSync(layer.agentJson())) {
    const base = agentType === "script" ? scriptAgentDefaults() : (AGENT_DEFAULTS as unknown as AgentJson);
    const merged = opts.overrides
      ? (deepMerge(
          base as unknown as Record<string, unknown>,
          opts.overrides as unknown as Record<string, unknown>,
        ) as unknown as AgentJson)
      : base;
    await writeFile(layer.agentJson(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
    scaffolded = true;
  }

  // 2) ScriptAgent: 写 src/index.ts
  if (agentType === "script") {
    const srcDir = join(layer.root(), "src");
    await mkdir(srcDir, { recursive: true });
    const indexFile = join(srcDir, "index.ts");
    if (!existsSync(indexFile)) {
      await writeFile(indexFile, defaultScriptTemplate(), "utf-8");
      scaffolded = true;
    }
  }

  return { scaffolded, agentType };
}
