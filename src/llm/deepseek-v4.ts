// @desc DeepSeek V4 provider — thinking mode toggle + reasoning_content replay for tool-call turns.

import { registerProvider, downgradeEffort, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import {
  openAICompatStream,
  normalizeBaseUrl,
  type OpenAIAssistantTransform,
} from "./openai-compat.js";

/**
 * DeepSeek V4 thinking-mode control.
 *
 * Per the 2026-04-24 API update:
 *   - `thinking: {type: "enabled"|"disabled"}` toggles chain-of-thought output. Default enabled.
 *   - In thinking mode only `reasoning_effort` values "high" and "max" are accepted;
 *     everything else gets silently downgraded server-side. We call `downgradeEffort` with
 *     `["high","max"]` as the supported set so the value we send matches what's honored —
 *     concretely: low/medium/high/xhigh → "high", max → "max" (xhigh lands on high because
 *     downgradeEffort walks downward to the nearest supported level).
 *   - In thinking mode, historical assistant turns need `reasoning_content` replayed back to
 *     the API on subsequent turns or the API may return HTTP 400.
 *   - Non-thinking mode (reasoningEffort null/undefined) sends `{type: "disabled"}` to make
 *     the intent explicit and avoid surprise reasoning-token charges on default-enabled models.
 *
 * When fallback reaches DeepSeek after another provider produced tool calls, historical assistant
 * turns may not have DeepSeek-native reasoning content. `reasoning_content` is not a framework
 * storage field; we derive it from the framework-level `thinking` field at the provider boundary.
 * If historical thinking is not visible, we still include an empty field so DeepSeek's request
 * validator does not reject the history shape before the model can answer.
 */
function createDeepSeekV4Provider(opts: ProviderFactoryOpts): LLMProvider {
  const effortSend = opts.reasoningEffort
    ? downgradeEffort(opts.reasoningEffort, ["high", "max"])
    : undefined;

  const extraBody = effortSend
    ? { thinking: { type: "enabled" } }
    : { thinking: { type: "disabled" } };

  // `reasoning_content` is DeepSeek wire format; framework storage stays on `thinking`.
  const assistantTransform: OpenAIAssistantTransform = (apiMsg, srcMsg: LLMMessage) => {
    if (!effortSend) return;
    apiMsg.reasoning_content = srcMsg.thinking ?? "";
  };

  return {
    async *chatStream(system, messages, tools, signal) {
      yield* openAICompatStream(
        {
          providerName: "deepseek-v4",
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.deepseek.com"),
          temperature: opts.temperature ?? 1.0,
          maxTokens: opts.maxTokens,
          reasoningEffort: effortSend,
          extractReasoning: !!effortSend,
          extraBody,
          assistantTransform,
        },
        system,
        messages,
        tools,
        signal,
      );
    },
  };
}

registerProvider("deepseek-v4", createDeepSeekV4Provider);

export { createDeepSeekV4Provider };
