// Stage C — focused one-shot text-completion API for plugins / Model Lab.
//
// Separate from `src/llm/provider.ts` (the agent session-loop streaming router
// with retries / fallback chains / agent.json wiring). Plugin authors don't
// want that surface — they want `gateway.llm.complete({model, messages})`,
// get text back, done.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompleteRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Caller can name a registered transport explicitly; default = auto-route by model prefix. */
  transport?: string;
  /** Per-call abort (timeout etc). Gateway also enforces an internal default timeout. */
  signal?: AbortSignal;
}

export interface CompleteUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompleteResponse {
  text: string;
  model: string;
  /** Which transport actually served the request (lets UI badge live source). */
  transport: string;
  latencyMs: number;
  usage?: CompleteUsage;
  /** Original provider id echoed back (e.g. LiteLLM may rewrite alias → real). */
  upstreamModel?: string;
}

export interface TransportOpts {
  baseUrl?: string;
  apiKey?: string;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface LlmTransport {
  name: string;
  complete(req: CompleteRequest, opts: TransportOpts): Promise<CompleteResponse>;
}
