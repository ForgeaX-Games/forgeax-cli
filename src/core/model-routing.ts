/** model-routing —— 多模型 fallback 时的内存粘性 + 冷却。
 *
 *  与 agenteam ref 完全 1:1。
 *
 *  逻辑：
 *  - models 配成 ["A","B","C"] 时，最近一次 A 成功 → ttlMs 内继续优先 A；
 *  - A 触发 LLMFallback → 把 A 放入 cooldownUntilByModel，直到 cooldownMs 过期；
 *  - order(config) 输出加工后的候选顺序，给 provider registry 拿去顺序尝试；
 *  - configKey 带 agentId + models + routing，配置变化 hint 自动重置。
 *
 *  纯内存，per-agent 实例化（ConsciousAgent 持有），进程重启丢弃 hint。 */

import type { ModelsConfig } from "../core/types";

interface ModelRoutingHint {
  configKey: string;
  stickyModel?: string;
  stickyUntil?: number;
  cooldownUntilByModel: Record<string, number>;
}

const DEFAULT_MODEL_STICKY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MODEL_COOLDOWN_MS = 30 * 1000;

function normalizeModelList(model: ModelsConfig["model"]): string[] {
  return (Array.isArray(model) ? model : [model ?? ""]).filter(Boolean);
}

function configKey(agentId: string, config: ModelsConfig): string {
  return JSON.stringify({
    agentId,
    model: config.model,
    routing: config.routing,
  });
}

export class ModelRoutingHints {
  private hint: ModelRoutingHint | undefined;

  constructor(private readonly agentId: string) {}

  order(config: ModelsConfig): ModelsConfig {
    const models = normalizeModelList(config.model);
    if (models.length <= 1 || config.routing?.stickiness?.enabled === false) return config;

    const hint = this.ensureHint(config);
    const now = Date.now();
    const available = models.filter((m) => (hint.cooldownUntilByModel[m] ?? 0) <= now);
    const ordered = available.length > 0 ? available : models;

    if (
      hint.stickyModel &&
      hint.stickyUntil &&
      hint.stickyUntil > now &&
      ordered.includes(hint.stickyModel)
    ) {
      return {
        ...config,
        model: [hint.stickyModel, ...ordered.filter((m) => m !== hint.stickyModel)],
      };
    }

    return { ...config, model: ordered };
  }

  recordSuccess(config: ModelsConfig, model: string | undefined): void {
    if (!model) return;
    const models = normalizeModelList(config.model);
    if (models.length <= 1 || config.routing?.stickiness?.enabled === false || !models.includes(model)) return;

    const hint = this.ensureHint(config);
    const ttlMs = config.routing?.stickiness?.ttlMs ?? DEFAULT_MODEL_STICKY_TTL_MS;
    hint.stickyModel = model;
    hint.stickyUntil = Date.now() + ttlMs;
  }

  recordFallback(config: ModelsConfig, from: string, error: Error): void {
    const models = normalizeModelList(config.model);
    if (models.length <= 1 || config.routing?.stickiness?.enabled === false || !models.includes(from)) return;

    const hint = this.ensureHint(config);
    const retryDelayMs = typeof (error as { retryDelayMs?: unknown }).retryDelayMs === "number"
      ? (error as { retryDelayMs?: number }).retryDelayMs
      : undefined;
    const cooldownMs = retryDelayMs ?? config.routing?.stickiness?.cooldownMs ?? DEFAULT_MODEL_COOLDOWN_MS;

    hint.cooldownUntilByModel[from] = Date.now() + cooldownMs;
    if (hint.stickyModel === from) {
      hint.stickyModel = undefined;
      hint.stickyUntil = undefined;
    }
  }

  private ensureHint(config: ModelsConfig): ModelRoutingHint {
    const key = configKey(this.agentId, config);
    if (this.hint?.configKey !== key) {
      this.hint = { configKey: key, cooldownUntilByModel: {} };
    }
    return this.hint;
  }
}
