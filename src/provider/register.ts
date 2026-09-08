/**
 * Provider 注册表 (C4) — backend(api) → factory 映射 + 解析。
 *
 * core-layer-spec §3.3：provider 两正交轴（backend / model 代际），不 fork。
 * backend 用 `api` 字符串标识（如 'anthropic-messages'）；同 backend 不同模型代际
 * 走 per-model hook / api_base，不另注册。
 *
 * Boundary：只 import C4 契约 + 本子目录 anthropic 工厂。
 */

import { createAnthropicProvider } from './anthropic';
import { createOpenAICompatProvider } from './openai-compat';
import { createOpenAIResponseProvider } from './openai-response';
import { createGeminiProvider } from './gemini';
import { createDeepSeekProvider } from './deepseek';
import { createBedrockProvider } from './bedrock';
import { createVertexProvider } from './vertex';
import {
  EMPTY_USAGE,
  mergeUsage,
  type LLMProvider,
  type ProviderBoundaryTraceEvent,
  type ProviderFactory,
  type ProviderFactoryOpts,
  type ProviderRequest,
  type Usage,
} from './types';
import { wireModel } from './model-id';

const registry = new Map<string, ProviderFactory>();

/** 注册一个 backend 工厂。重复注册同 api 覆盖（后者赢）。 */
export function registerProvider(api: string, factory: ProviderFactory): void {
  registry.set(api, factory);
}

/** 解析并实例化 provider；未注册的 api 抛错。 */
export function resolveProvider(api: string, opts: ProviderFactoryOpts): LLMProvider {
  const factory = registry.get(api);
  if (!factory) {
    throw new Error(
      `unknown provider api: '${api}'. registered: ${[...registry.keys()].join(', ') || '(none)'}`,
    );
  }
  return withWireModelNormalization(factory(opts));
}

/**
 * 在 provider 边界统一规整 wire 模型名(剥掉 `[1m]` 这类内部标记后缀)——所有 provider、
 * 所有调用方(主轮/子 agent/压缩/auto-memory)的唯一收口。防御泄漏的 `ANTHROPIC_MODEL`
 * (如 cc 的 `claude-opus-4-8[1m]`)被原样发出导致 401。见 ./model-id。
 */
let providerBoundarySequence = 0;

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)) return error.name;
  return typeof error === 'object' && error !== null ? 'ProviderError' : typeof error;
}

function safeHttpStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) return undefined;
  return value;
}

function safeEndpointOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function requestScale(req: ProviderRequest): ProviderBoundaryTraceEvent['requestScale'] {
  return {
    systemBlocks: req.system.length,
    messages: req.messages.length,
    tools: req.tools.length,
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
  };
}

/** The wrapper is the single resolved-adapter boundary for every registered
 * provider. Its trace surrounds the concrete adapter's `stream`, not an outer
 * Studio/sidecar dispatch, and emits metadata only. */
function withWireModelNormalization(provider: LLMProvider): LLMProvider {
  const endpointOrigin = safeEndpointOrigin(provider.endpointOrigin);
  return {
    api: provider.api,
    ...(endpointOrigin ? { endpointOrigin } : {}),
    async *stream(req, callOpts) {
      const model = wireModel(req.model);
      const wireReq = model === req.model ? req : { ...req, model };
      const trace = callOpts.boundaryTrace;
      if (!trace) {
        yield* provider.stream(wireReq, callOpts);
        return;
      }

      const sequence = ++providerBoundarySequence;
      const startedAtMs = Date.now();
      const common = {
        sequence,
        callId: trace.callId,
        threadId: trace.threadId,
        providerApi: provider.api,
        ...(endpointOrigin ? { endpointOrigin } : {}),
        model,
        startedAtMs,
        requestScale: requestScale(wireReq),
      };
      trace.emit({ phase: 'start', ...common });

      let usage: Usage = { ...EMPTY_USAGE };
      let stopReason: ProviderBoundaryTraceEvent['stopReason'] = null;
      let requestId: string | undefined;
      let httpStatus: number | undefined;
      try {
        for await (const event of provider.stream(wireReq, callOpts)) {
          if (event.type === 'message_start' || event.type === 'message_delta') {
            usage = mergeUsage(usage, event.usage);
          } else if (event.type === 'assistant') {
            usage = mergeUsage(usage, event.usage);
            stopReason = event.stopReason;
            requestId = event.requestId;
            httpStatus = safeHttpStatus(event.httpStatus);
          }
          if (event.type === 'message_delta' && event.stopReason !== null) stopReason = event.stopReason;
          yield event;
        }
        const completedAtMs = Date.now();
        trace.emit({
          phase: 'complete',
          ...common,
          completedAtMs,
          durationMs: completedAtMs - startedAtMs,
          logicalStatus: 'completed',
          stopReason,
          ...(requestId ? { requestId } : {}),
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          usage,
        });
      } catch (error) {
        const completedAtMs = Date.now();
        const status = safeHttpStatus((error as { status?: unknown } | null)?.status);
        trace.emit({
          phase: 'error',
          ...common,
          completedAtMs,
          durationMs: completedAtMs - startedAtMs,
          logicalStatus: 'error',
          ...(status !== undefined ? { httpStatus: status } : {}),
          errorClass: safeErrorClass(error),
        });
        throw error;
      }
    },
  };
}

/** 列出已注册 backend。 */
export function listProviders(): string[] {
  return [...registry.keys()];
}

// ─── 内置注册 ──────────────────────────────────────────────────────────────

registerProvider('anthropic-messages', createAnthropicProvider);
registerProvider('openai-compat', createOpenAICompatProvider);
registerProvider('openai-responses', createOpenAIResponseProvider);
registerProvider('gemini', createGeminiProvider);
registerProvider('deepseek-v4', createDeepSeekProvider);
// 云网关 backend(Anthropic via 云):复用 normalizeAnthropicStream,仅换请求构造 + 鉴权。
//   vertex = SSE 直接复用 parseSSE;bedrock = SigV4 + event-stream 帧 decoder。
registerProvider('bedrock-anthropic', createBedrockProvider);
registerProvider('vertex-anthropic', createVertexProvider);
