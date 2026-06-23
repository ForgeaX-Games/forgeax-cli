// LiteLLM proxy `/v1/chat/completions` transport.
//
// Studio's .env routes ANTHROPIC/OPENAI/LITELLM keys all at the same proxy host
// (`LITELLM_PROXY_BASE_URL`), so one OpenAI-compat transport covers Claude /
// GPT / Gemini / GLM / Kimi / Qwen / DeepSeek / Minimax / Hunyuan with the
// same wire shape. No per-vendor branching — the proxy adapts upstream. Other
// transports (native anthropic /v1/messages, gemini /generateContent etc) can
// be added if a deployment ever bypasses the proxy; current shipping path
// needs only this.

import type { CompleteRequest, CompleteResponse, LlmTransport, TransportOpts } from '../types';

interface LiteLLMChoice {
  message?: { content?: string };
  finish_reason?: string;
}
interface LiteLLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface LiteLLMResponse {
  id?: string;
  model?: string;
  choices?: LiteLLMChoice[];
  usage?: LiteLLMUsage;
  error?: { message?: string; type?: string };
}

export const litellmTransport: LlmTransport = {
  name: 'litellm',
  async complete(req: CompleteRequest, opts: TransportOpts): Promise<CompleteResponse> {
    const baseUrl = (opts.baseUrl ?? process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = opts.apiKey ?? process.env.LITELLM_PROXY_KEY ?? '';
    if (!baseUrl) throw new Error('litellm transport: LITELLM_PROXY_BASE_URL not set');
    if (!apiKey) throw new Error('litellm transport: LITELLM_PROXY_KEY not set');

    const fetcher = opts.fetcher ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    // Compose abort: caller signal OR internal timeout, whichever fires first.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(req.signal?.reason);
    if (req.signal) {
      if (req.signal.aborted) ctrl.abort(req.signal.reason);
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    const started = Date.now();
    try {
      const resp = await fetcher(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      const raw = await resp.text();
      let parsed: LiteLLMResponse;
      try {
        parsed = JSON.parse(raw) as LiteLLMResponse;
      } catch {
        throw new Error(`litellm transport: non-JSON response (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
      }
      if (!resp.ok) {
        const msg = parsed.error?.message ?? `HTTP ${resp.status}`;
        throw new Error(`litellm transport: ${msg}`);
      }
      const text = parsed.choices?.[0]?.message?.content ?? '';
      return {
        text,
        model: req.model,
        upstreamModel: parsed.model,
        transport: 'litellm',
        latencyMs: Date.now() - started,
        usage: parsed.usage ? {
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
        } : undefined,
      };
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
  },
};
