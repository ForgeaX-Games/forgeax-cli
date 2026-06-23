// @desc Workspace kit condition + per-kit defaults
//
// 整套 workspace 工具默认 ON（agent.json::kits.enable 不需要列），由
// operationLevel 控制写 / 编辑工具的可见性（read-only ↔ read-write）。

import type { AgentContext } from "../../../src/core/types";

export default function condition(_ctx: AgentContext): boolean {
  return true;
}

/** 首次 load 时 patch 进 agent.json::kits.config.workspace。Subagent 模板若
 *  显式覆盖（"read-only"）则不会被这里的默认值改回去。
 *
 *  级别：
 *    "read-only"  — glob / grep / list_dir / read_file / shell 可用
 *    "read-write" — 上面 + write_file / edit_file / multi_edit / apply_patch */
export const configDefaults = {
  operationLevel: "read-write",
};

export const WORKSPACE_BOARD_KEY = "workspace:operationLevel";

/** Resolve operationLevel —— blackboard 动态值 > agent.json 配置 > 默认 "read-write"。 */
export function getOperationLevel(ctx: AgentContext): string {
  const dynamic = ctx.blackboard.get(ctx.agentPath, WORKSPACE_BOARD_KEY) as string | undefined;
  if (dynamic) return dynamic;
  const fromJson = (ctx.getAgentJson() as any).kits?.config?.workspace?.operationLevel;
  return fromJson ?? "read-write";
}
