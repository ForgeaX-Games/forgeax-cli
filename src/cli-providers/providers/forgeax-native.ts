/**
 * Forgeax-native driver — Phase C2 of the architecture-evolution roadmap.
 *
 * Implements the new `Driver` contract from `@forgeax/agent-runtime` directly
 * on top of `lib/llm-gateway`. Unlike claude-code / codex / cursor-agent, this
 * driver requires no external CLI binary — it talks to the LiteLLM proxy (or
 * any vendor `.env` recognizes) via the gateway's `complete()` call.
 *
 * Status: bottom-of-stack fallback. Always usable as long as `.env` has either
 *   - `LITELLM_PROXY_KEY` + `LITELLM_PROXY_BASE_URL` (proxy mode), OR
 *   - per-vendor creds matching DEFAULT_MODEL's id pattern
 *     (e.g. `ANTHROPIC_API_KEY` for `claude-*`).
 *
 * The driver is non-streaming for now (gateway.complete is one-shot). Tokens
 * are yielded as a single 'token' event followed by 'usage' + 'done'. A future
 * pass can wire the streaming transport when SSE adapters land.
 */
import type {
  Driver,
  DriverChatStream,
  DriverHealth,
  ChatTurnRequest,
  Session,
  ChatEvent,
} from '@forgeax/agent-runtime';
import { complete } from '../../lib/llm-gateway';
import type { ChatMessage } from '../../lib/llm-gateway';
import { resolveModelAdapter } from '../../llm/auto-resolver';

const DEFAULT_MODEL =
  process.env.FORGEAX_DEFAULT_MODEL?.trim() ||
  // The studio's litellm proxy fans this out to whatever upstream is configured;
  // claude-3-5-sonnet is the de-facto pick across our key sections.
  'claude-3-5-sonnet-20241022';

function pickModel(req: ChatTurnRequest): string {
  // Allow per-turn override via attachments[].model (open-shape, see ChatTurnRequest).
  const a = req.attachments?.find((x) => typeof x.model === 'string');
  return (a?.model as string | undefined)?.trim() || DEFAULT_MODEL;
}

function buildMessages(session: Session, req: ChatTurnRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sys = session.agent.systemPrompt?.trim();
  if (sys) out.push({ role: 'system', content: sys });
  out.push({ role: 'user', content: req.text });
  return out;
}

export class ForgeaxNativeDriver implements Driver {
  readonly id = 'forgeax-native';
  readonly name = 'Forgeax Native';
  readonly selfContained = true;

  async health(): Promise<DriverHealth> {
    try {
      const r = resolveModelAdapter(DEFAULT_MODEL, process.env);
      const proxyMode = process.env.LITELLM_PROXY_KEY && process.env.LITELLM_PROXY_BASE_URL;
      const detail = proxyMode
        ? `routing '${DEFAULT_MODEL}' via LiteLLM proxy (${r.api})`
        : `routing '${DEFAULT_MODEL}' direct (${r.api})`;
      return { ok: true, name: this.id, detail };
    } catch (e) {
      return { ok: false, name: this.id, detail: (e as Error).message };
    }
  }

  async chat(session: Session, req: ChatTurnRequest): Promise<DriverChatStream> {
    const ctrl = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) ctrl.abort();
      else req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }

    const model = pickModel(req);
    const messages = buildMessages(session, req);

    // Eagerly fire the request; the async iterator below resolves the same
    // promise. Doing it here (rather than inside the generator) lets `cancel()`
    // hit a real in-flight fetch.
    const pending = complete({ model, messages, signal: ctrl.signal });

    async function* events(): AsyncIterator<ChatEvent> {
      try {
        const res = await pending;
        if (res.text) yield { kind: 'token', text: res.text };
        if (res.usage) {
          yield {
            kind: 'usage',
            promptTokens: res.usage.promptTokens,
            completionTokens: res.usage.completionTokens,
            totalTokens: res.usage.totalTokens,
          };
        }
        yield { kind: 'done', reason: 'end_turn' };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const aborted = ctrl.signal.aborted || /aborted/i.test(msg);
        yield { kind: 'error', message: msg, recoverable: !aborted };
        yield { kind: 'done', reason: aborted ? 'cancelled' : 'error' };
      }
    }

    const iter = events();
    return {
      [Symbol.asyncIterator]() { return iter; },
      async cancel() { ctrl.abort(); },
    };
  }
}

export const forgeaxNativeDriver = new ForgeaxNativeDriver();
