/** resolveModelsConfig —— `agent.json::models` 的解析链。
 *
 *  与 agenteam ref 的差异（plan §3.x）：
 *  - ref 的 fallback 是 `agenteam.json::models`（全局配置文件）；forgeax 的 fallback
 *    是 `session.json::defaultModels`（每个 session 自己的默认）。
 *  - 由 caller（ConsciousAgent / summary-compaction）传入 sessionDefaults，避免
 *    runtime 层级再搞 readFileSync 同步 IO。
 *
 *  解析链：
 *    1) agent.json::models.model 已配 → 直接返回 agent.json 的 ModelsConfig
 *    2) 否则：mergeModelsConfig(sessionDefaults, agentModels) —— session-level
 *       defaults 兜底，agent-level 字段覆盖
 *    3) 仍无 model → 由 caller 报错（这里只负责合并） */

import type { AgentJson, ModelsConfig } from "./types";

/** Shallow merge ModelsConfig：override 的非空字段覆盖 base，routing 嵌套用 spread。 */
function mergeModelsConfig(base: ModelsConfig, override: ModelsConfig): ModelsConfig {
  return {
    ...base,
    ...override,
    routing: { ...(base.routing ?? {}), ...(override.routing ?? {}) },
  };
}

export function resolveModelsConfig(
  agentJson: AgentJson,
  sessionDefaults: ModelsConfig | undefined,
): ModelsConfig {
  const agent = agentJson.models ?? {};
  if (agent.model) return agent;
  return mergeModelsConfig(sessionDefaults ?? {}, agent);
}
