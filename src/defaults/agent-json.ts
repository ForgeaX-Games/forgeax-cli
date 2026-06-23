/** `agent.json` 默认值 SSOT。
 *
 *  scaffolding 时（SessionManager.create / spawn_subagent）和调用方传入的 override
 *  做 deep-merge 后写盘；agent 层运行时也按 `??` 兜底读这里的字段。
 *
 *  本轮（C0-C12）只覆盖 LLM turn loop + micro-compaction 真正消费到的字段。
 *  kits 子系统骨架已就位（src/kits/），内容填充见 runtime-rewrite-gaps.md §B1。 */

import type { AgentJson } from "../core/types";

/** 把 T 内每一层可选字段都补成必选 —— 内置 `Required<T>` 只剥顶层。
 *  让上层可以稳拿 `AGENT_DEFAULTS.models.maxRetries` 而不必再判 undefined。 */
type DeepRequired<T> = T extends object
  ? { [K in keyof T]-?: DeepRequired<T[K]> }
  : T;

/** `null` 在 ModelsConfig 字段里表示「继承上级 / provider 默认 / 不下发该参数」；
 *  `model` 单独走数组形态（fallback chain），即使只有一个模型也写成 ["..."]，
 *  方便 resolve-models 顺序消费、UI 始终把它当 chain 处理。 */
export const AGENT_DEFAULTS: DeepRequired<AgentJson> = {
  models: {
    model: ["claude-opus-4-8"],
    temperature: null,
    maxTokens: null,
    reasoningEffort: "high",
    showThinking: true,
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    timeout: -1,
    routing: {
      stickiness: {
        enabled: true,
        ttlMs: 5 * 60 * 1000,
        cooldownMs: 30 * 1000,
      },
    },
  },
  coalesceMs: 300,
  maxIterations: 200,
  historyKeep: {
    recentTools: 20,
    recentMedias: 2,
    idleGapMs: 20 * 60 * 1000,
  },
  timezone: "Asia/Shanghai",
  defaultDir: ".",
  defaultStatus: "",
  kits: {
    user: "none",
    session: "none",
    enable: [],
    disable: [],
    config: {},
  },
  kitRedirect: "",
  personaFile: "",
  memoryDir: "",
};
