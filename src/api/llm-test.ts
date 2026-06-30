// /api/llm/test — Model Lab one-shot completion endpoint.
//
// Stage E: the Model Lab UI (SettingsPanel → Model Lab section) hits this to
// fire a single prompt at a chosen model with caller-tuned temperature / top_p
// / max_tokens, and renders back text + latency + token usage. Mirrors the
// agentic_os "test-params" panel that you built in 3rd/agentic_os —
// designed for "does this model still work?" smoke tests, not session loops.
//
// Wraps lib/llm-gateway.complete() — that's the SSOT for transport routing.
// This router only validates body, times the call, and shapes the response so
// the UI never has to differentiate "transport threw" from "model said no":
//   success → { ok:true, text, latencyMs, usage?, transport, upstreamModel? }
//   failure → { ok:false, error, latencyMs, transport? }   (HTTP 200 either way)
//
// Why 200 on gateway throw: the UI wants to show the error inline next to the
// timing, not handle a network failure. Real failures (router not mounted, JSON
// parse) still get the standard Hono error path.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { complete, type ChatMessage } from '../lib/llm-gateway';

interface TestRequestBody {
  model?: string;
  prompt?: string;
  system?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export function createLlmTestRouter() {
  const app = new Hono();

  app.post('/test', async (c) => {
    let body: TestRequestBody;
    try {
      body = (await c.req.json()) as TestRequestBody;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    const model = body.model?.trim();
    const prompt = body.prompt?.trim();
    if (!model) return c.json({ ok: false, error: 'model is required' }, 400);
    if (!prompt) return c.json({ ok: false, error: 'prompt is required' }, 400);

    const messages: ChatMessage[] = [];
    if (body.system && body.system.trim()) {
      messages.push({ role: 'system', content: body.system });
    }
    messages.push({ role: 'user', content: prompt });

    const started = Date.now();
    try {
      const resp = await complete({
        model,
        messages,
        temperature: body.temperature,
        topP: body.topP,
        maxTokens: body.maxTokens,
      });
      return c.json({
        ok: true,
        text: resp.text,
        latencyMs: resp.latencyMs,
        transport: resp.transport,
        upstreamModel: resp.upstreamModel,
        usage: resp.usage,
      });
    } catch (e) {
      return c.json({
        ok: false,
        error: (e as Error).message,
        latencyMs: Date.now() - started,
      });
    }
  });

  // /api/llm/test-stream — same body shape as /test but answers via SSE so
  // the Model Lab batch table can measure TTFT (time-to-first-chunk) + total
  // duration + tok/s independently per model. Events:
  //   event: meta   data: {model, upstreamModel?, transport, ttftStartedAt}
  //   event: chunk  data: {delta, ts}          — one per emitted token group
  //   event: done   data: {ttftMs, totalMs, usage?, transport}
  //   event: error  data: {error, ttftMs?, totalMs}
  // The frontend keeps a per-row state machine and treats the first `chunk`
  // arrival as TTFT (which is what users mean by "first token latency").
  app.post('/test-stream', async (c) => {
    let body: TestRequestBody;
    try {
      body = (await c.req.json()) as TestRequestBody;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const model = body.model?.trim();
    const prompt = body.prompt?.trim();
    if (!model) return c.json({ ok: false, error: 'model is required' }, 400);
    if (!prompt) return c.json({ ok: false, error: 'prompt is required' }, 400);

    const messages: ChatMessage[] = [];
    if (body.system && body.system.trim()) {
      messages.push({ role: 'system', content: body.system });
    }
    messages.push({ role: 'user', content: prompt });

    const baseUrl = (process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = process.env.LITELLM_PROXY_KEY ?? '';

    return streamSSE(c, async (stream) => {
      const started = Date.now();
      let firstChunkAt: number | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let upstreamModel: string | undefined;

      if (!baseUrl || !apiKey) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: !baseUrl ? 'LITELLM_PROXY_BASE_URL not set' : 'LITELLM_PROXY_KEY not set',
            totalMs: Date.now() - started,
          }),
        });
        return;
      }

      const ac = new AbortController();
      // Hono runs the streamSSE callback in a context where the request abort
      // signal would manifest as stream.aborted. We propagate that into our
      // upstream fetch so the LiteLLM connection closes when the browser
      // navigates away mid-stream.
      stream.onAbort(() => ac.abort());

      try {
        await stream.writeSSE({
          event: 'meta',
          data: JSON.stringify({ model, transport: 'litellm', startedAt: started }),
        });

        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            ...(body.topP !== undefined ? { top_p: body.topP } : {}),
            ...(body.maxTokens !== undefined ? { max_tokens: body.maxTokens } : {}),
          }),
          signal: ac.signal,
        });

        if (!resp.ok) {
          const raw = await resp.text().catch(() => '');
          let msg = `HTTP ${resp.status}`;
          try {
            const j = JSON.parse(raw) as { error?: { message?: string } };
            if (j.error?.message) msg = j.error.message;
          } catch { /* keep HTTP code */ }
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: msg, totalMs: Date.now() - started }),
          });
          return;
        }

        if (!resp.body) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: 'upstream returned no body', totalMs: Date.now() - started }),
          });
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by blank lines.
          let nl: number;
          while ((nl = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const j = JSON.parse(data) as {
                  model?: string;
                  choices?: Array<{ delta?: { content?: string } }>;
                  usage?: typeof usage;
                };
                if (j.model && !upstreamModel) upstreamModel = j.model;
                if (j.usage) usage = j.usage;
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                  const now = Date.now();
                  if (firstChunkAt === null) firstChunkAt = now;
                  await stream.writeSSE({
                    event: 'chunk',
                    data: JSON.stringify({ delta, ts: now }),
                  });
                }
              } catch { /* skip malformed frame */ }
            }
          }
        }

        const totalMs = Date.now() - started;
        const ttftMs = firstChunkAt !== null ? firstChunkAt - started : null;
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            ttftMs,
            totalMs,
            transport: 'litellm',
            upstreamModel,
            usage: usage ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            } : undefined,
          }),
        });
      } catch (e) {
        const totalMs = Date.now() - started;
        const ttftMs = firstChunkAt !== null ? firstChunkAt - started : undefined;
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: (e as Error).message ?? String(e),
            ttftMs,
            totalMs,
          }),
        });
      }
    });
  });

  return app;
}
