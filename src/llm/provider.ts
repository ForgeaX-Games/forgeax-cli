/** LLM Provider registry — config-driven adapter factory with fallback chain support */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { prepareMessagesForModel } from "../message/modality.js";
import { prepareMessagesForMediaPolicy } from "./media-preflight.js";
import {
  createPendingToolMessages,
  createToolResultMessage,
} from "../context-window/tool-normalizer.js";
import type { ModelSpec, ModelsConfig, ReasoningEffort } from "../core/types.js";
import { responseToAssistantMessage } from "./stream.js";
import type { LLMProvider } from "./types.js";
import { withRetry, calculateDelay, type RetryOptions, type RetryInfo } from "./retry.js";
import { annotateLLMError, classifyLLMError, getRecommendedDelay } from "./errors.js";
import { sleep } from "../utils.js";
import { getSharedPaths } from "../fs/state-dir.js";
import { resolveModelAdapter } from "./auto-resolver.js";

// ── Types ────────────────────────────────────────────────────────

export interface ProviderFactoryOpts {
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

type ProviderFactory = (opts: ProviderFactoryOpts) => LLMProvider;

// ── Adapter Registry (keyed by api type, e.g. "google-gemini-2") ──

const registry = new Map<string, ProviderFactory>();

export function registerProvider(apiType: string, factory: ProviderFactory): void {
  registry.set(apiType, factory);
}

// ── model id parsing (legacy `model@section` syntax tolerated, ignored) ──

export function parseModelSpec(raw: string): { model: string; keySection?: string } {
  const at = raw.lastIndexOf("@");
  if (at > 0 && at < raw.length - 1) {
    return { model: raw.slice(0, at), keySection: raw.slice(at + 1) };
  }
  return { model: raw };
}

function getKeyDir(): string {
  try {
    return getSharedPaths().keyDir();
  } catch {
    return resolve(process.cwd(), "key");
  }
}

// ── Model catalog loading (key/models.json) ──────────────────────

const DEFAULT_SPEC: ModelSpec = {
  input: ["text"],
  reasoning: false,
  contextWindow: 128000,
  maxOutput: 4096,
  defaultTemperature: 0.7,
};

/** Always re-read from disk so model spec changes take effect without restart. */
function loadModelCatalog(): Record<string, ModelSpec> {
  const p = resolve(getKeyDir(), "models.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* malformed JSON */ }
  }
  return {};
}

export function getModelSpec(model: string): ModelSpec {
  const catalog = loadModelCatalog();
  return catalog[model] ?? DEFAULT_SPEC;
}

// ── Effort downgrade ─────────────────────────────────────────────

/** Canonical effort ordering from lowest to highest. */
const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "minimal", "low", "medium", "high", "xhigh", "max",
];

/**
 * Downgrade a reasoning effort level to the nearest supported level.
 * Searches downward first (prefer less effort), then upward if nothing below.
 */
export function downgradeEffort(
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  const set = new Set<ReasoningEffort>(supported);
  if (set.has(effort)) return effort;
  const idx = EFFORT_ORDER.indexOf(effort);
  for (let i = idx - 1; i >= 0; i--) {
    if (set.has(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  for (let i = idx + 1; i < EFFORT_ORDER.length; i++) {
    if (set.has(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  return effort;
}

// ── Resolve final model params (models.json defaults + agent.json overrides) ──

export interface ResolvedModelParams {
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
}

/**
 * 解析模型参数
 * @param model 模型名称
 * @param modelsConfig 模型配置
 */
export function resolveModelParams(
  model: string,
  modelsConfig?: ModelsConfig,
): ResolvedModelParams {
  const spec = getModelSpec(model);

  const temperature = modelsConfig?.temperature ?? spec.defaultTemperature;
  const maxTokens = modelsConfig?.maxTokens ?? spec.maxOutput;
  const reasoningEffort = spec.reasoning
    ? (modelsConfig?.reasoningEffort ?? undefined)
    : undefined;

  return { temperature, maxTokens, reasoningEffort };
}

/**
 * 从 ModelsConfig 构建 RetryOptions
 */
export function buildRetryOptions(modelsConfig?: ModelsConfig): RetryOptions {
  const opts: RetryOptions = {};

  if (modelsConfig?.maxRetries !== undefined) {
    opts.maxRetries = modelsConfig.maxRetries;
  }
  if (modelsConfig?.baseDelayMs !== undefined) {
    opts.baseDelayMs = modelsConfig.baseDelayMs;
  }
  if (modelsConfig?.maxDelayMs !== undefined) {
    opts.maxDelayMs = modelsConfig.maxDelayMs;
  }

  return opts;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Merge two ModelsConfig objects, with override fields taking precedence.
 * Undefined and null values in override are ignored (base value is kept).
 */
export function mergeModelsConfig(base: ModelsConfig, override: ModelsConfig): ModelsConfig {
  const result = { ...base };
  for (const [k, v] of Object.entries(override) as [keyof ModelsConfig, unknown][]) {
    if (v !== undefined && v !== null) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

/**
 * 创建 Provider。
 * 自动根据 model 字段选择单模型或 fallback 链。
 */
export function createProvider(
  modelsConfig: ModelsConfig,
): LLMProvider {
  const raw = Array.isArray(modelsConfig.model) ? modelsConfig.model : [modelsConfig.model ?? ""];
  const valid = raw.filter(Boolean);
  if (valid.length > 1) return createFallbackProvider(() => modelsConfig);
  if (!valid[0]) throw new Error("No model specified in ModelsConfig");

  const modelSpec = valid[0];
  const { model } = parseModelSpec(modelSpec);

  const { api: apiType, apiKey: resolvedApiKey, apiBase: resolvedApiBase } =
    resolveModelAdapter(model, process.env);
  const factory = registry.get(apiType);
  if (!factory) {
    throw new Error(
      `No adapter registered for api type '${apiType}'. ` +
      `Available: ${[...registry.keys()].join(", ")}`,
    );
  }

  const params = resolveModelParams(model, modelsConfig);
  const resolvedSpec = getModelSpec(model);
  const provider = factory({
    model,
    apiKey: resolvedApiKey,
    baseUrl: resolvedApiBase,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    reasoningEffort: params.reasoningEffort,
  });
  return {
    ...provider,
    // Default bridge layer: providers may enrich normalized messages, but generic
    // message normalization belongs to the shared message/session path instead.
    async prepareInboundMessages(messages, context) {
      const preflighted = await prepareMessagesForMediaPolicy(messages);
      return provider.prepareInboundMessages
        ? await provider.prepareInboundMessages(preflighted, context)
        : preflighted;
    },
    materializeAssistantMessage(response, options) {
      return provider.materializeAssistantMessage
        ? provider.materializeAssistantMessage(response, options)
        : responseToAssistantMessage(response, options);
    },
    materializePendingToolMessages(toolCalls, options) {
      return provider.materializePendingToolMessages
        ? provider.materializePendingToolMessages(toolCalls, options)
        : createPendingToolMessages(toolCalls).map((msg) => ({ ...msg, ts: options.ts }));
    },
    materializeToolResult(toolCall, result, options) {
      return provider.materializeToolResult
        ? provider.materializeToolResult(toolCall, result, options)
        : { ...createToolResultMessage(toolCall, result), ts: options.ts };
    },
    async *chatStream(system, messages, tools, signal) {
      const filtered = tools.filter(t => !t.modelFilter || t.modelFilter(model));
      try {
        for await (const chunk of provider.chatStream(
          system,
          prepareMessagesForModel(messages, resolvedSpec.input),
          filtered,
          signal,
        )) {
          yield chunk.type === "usage" ? { ...chunk, model } : chunk;
        }
      } catch (err) {
        annotateLLMError(err, { provider: apiType, model });
        throw err;
      }
    },
  };
}

export interface FallbackProviderOptions {
  retry?: RetryOptions;
  onRetry?: (model: string, info: RetryInfo) => void;
  onFallback?: (from: string, to: string, error: Error) => void;
}

/**
 * 创建无状态的 fallback provider。
 *
 * 每次 chatStream 调用时从 getModelsConfig() 读取最新配置（模型列表、重试策略、
 * temperature 等），因此 agent.json 的修改无需重建 provider 即可生效。
 *
 * 降级优先策略：每轮依次尝试链上所有模型（各试一次）；
 * 一轮全部失败后等待（指数退避），再进行下一轮。
 * 流开始后（已 yield chunk）不 fallback，直接抛出。
 */
export function createFallbackProvider(
  getModelsConfig: () => ModelsConfig,
  options?: FallbackProviderOptions,
): LLMProvider {
  const { onRetry, onFallback } = options ?? {};

  const resolveModels = () => {
    const mc = getModelsConfig();
    const raw = Array.isArray(mc.model) ? mc.model : [mc.model ?? ""];
    const models = raw.filter((m) => {
      if (!m) return false;
      try {
        const { model } = parseModelSpec(m);
        resolveModelAdapter(model, process.env);
        return true;
      } catch (err) {
        console.warn(`model "${m}" cannot be resolved from .env — skipped from fallback chain (${(err as Error).message})`);
        return false;
      }
    });
    if (models.length === 0 && raw.some(Boolean)) {
      console.error(`all models in fallback chain are invalid: [${raw.join(", ")}]`);
    }
    return { mc, models };
  };

  const getFirstModelProvider = () => {
    const { mc, models } = resolveModels();
    const firstModel = models.find(Boolean);
    return firstModel ? createProvider({ ...mc, model: firstModel }) : null;
  };

  return {
    async prepareInboundMessages(messages, context) {
      const { mc, models } = resolveModels();
      let prepared = messages;
      const seenModels = new Set<string>();
      for (const modelName of models) {
        if (!modelName || seenModels.has(modelName)) continue;
        seenModels.add(modelName);
        try {
          const provider = createProvider({ ...mc, model: modelName });
          prepared = await provider.prepareInboundMessages!(prepared, context);
        } catch {
          // Skip models that fail to resolve (e.g. missing .env credentials);
          // chatStream handles fallback with proper per-model error handling.
        }
      }
      return prepared;
    },
    materializeAssistantMessage(response, options) {
      const provider = getFirstModelProvider();
      return provider
        ? provider.materializeAssistantMessage!(response, options)
        : responseToAssistantMessage(response, options);
    },
    materializePendingToolMessages(toolCalls, options) {
      const provider = getFirstModelProvider();
      return provider
        ? provider.materializePendingToolMessages!(toolCalls, options)
        : createPendingToolMessages(toolCalls).map((msg) => ({ ...msg, ts: options.ts }));
    },
    materializeToolResult(toolCall, result, options) {
      const provider = getFirstModelProvider();
      return provider
        ? provider.materializeToolResult!(toolCall, result, options)
        : { ...createToolResultMessage(toolCall, result), ts: options.ts };
    },
    async *chatStream(system, messages, tools, signal) {
      const { mc, models } = resolveModels();
      if (!models[0]) throw new Error("No model specified in ModelsConfig");

      const retryOpts: RetryOptions = { ...options?.retry, ...buildRetryOptions(mc) };
      const maxRounds = (retryOpts.maxRetries ?? 5) + 1;
      let lastError: Error | undefined;
      let round = 0, hasRoundError = false;

      for (let i = 0; i < models.length; i++) {
        const modelName = models[i];
        let chunksYielded = false;

        try {
          const provider = createProvider({ ...mc, model: modelName });
          const stream = await withRetry(
            async () => {
              const it = provider.chatStream(system, messages, tools, signal)[Symbol.asyncIterator]();
              return { it, first: await it.next() };
            },
            { maxRetries: 0, signal },
          );

          if (!stream.first.done) { chunksYielded = true; yield stream.first.value; }

          for (let r = await stream.it.next(); !r.done; r = await stream.it.next()) {
            yield r.value;
          }
          return;
        } catch (err: unknown) {
          const classified = classifyLLMError(err);
          if (signal.aborted || classified.kind === "aborted") throw classified.error;
          if (chunksYielded) throw classified.error;
          lastError = classified.error;
          hasRoundError = true;
          if (i < models.length - 1) {
            onFallback?.(modelName, models[i + 1], classified.error);
          } else if (hasRoundError && ++round < maxRounds) {
            const delayMs = calculateDelay(round - 1, retryOpts.baseDelayMs ?? 1000, retryOpts.maxDelayMs ?? 30000, true, getRecommendedDelay(lastError));
            onRetry?.(modelName, { attempt: round, maxRetries: maxRounds - 1, error: lastError!, delayMs, willRetry: true });
            await sleep(delayMs, signal);
            hasRoundError = false;
            i = -1;
          }
        }
      }

      throw lastError ?? new Error("All models in fallback chain failed");
    },
  };
}
