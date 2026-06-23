// CliProvider — the abstraction over agent backends (forgeax-cli, the reference agent CLI,
// Codex, future homegrown providers). See docs/CLI-PROVIDERS-DESIGN.md.
//
// Phase 1: types only. ChatEvent here is a strict superset of the legacy
// server/src/agent/types.ts ChatEvent — adds optional emitterId/providerId
// fields. Existing producers/consumers keep working unchanged because the
// new fields are optional.

export type ProviderId = 'forgeax' | 'claude-code' | 'codex' | 'cursor-agent' | (string & {});

export interface ChatRequest {
  agentId: string;
  sessionId?: string;
  /**
   * Canonical chat-session id (= server thread.id = daemon SessionRuntime id).
   * Tabs in the UI map 1:1 onto a threadId, which we forward to the daemon as
   * its sessionId so per-tab isolation is real (independent EventBus +
   * ledger). When absent, forgeax provider falls back to a "default" session
   * -- that's the legacy single-session path.
   */
  threadId?: string;
  message: string;
  /**
   * Doc 05 section 7 -- per-call id used by `cancel(callId)` to abort an
   * in-flight chat without tearing down the whole provider. Caller-assigned;
   * uniqueness is the caller's responsibility (UI uses crypto.randomUUID).
   * When absent, the chat still runs but cannot be cancelled by id (only via
   * the request-scoped AbortSignal forwarded by the route handler).
   */
  callId?: string;
  /**
   * Doc 05 section 7 -- per-call deadline. When set, the provider auto-aborts
   * the call after `timeoutMs` and surfaces a structured terminal event with
   * `code: 'driver-timeout'`. 0 / negative / undefined = no per-call timeout
   * (the request still inherits the route AbortSignal).
   */
  timeoutMs?: number;
  /** Provider-specific overrides forwarded as-is (model, temperature, ...) */
  options?: Record<string, unknown>;
}

export type ChatEvent = (
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; name: string; args: unknown; callId: string }
  | { type: 'tool-call-delta'; callId: string; name: string; argumentsDelta: string }
  | { type: 'tool-result'; callId: string; ok: boolean; result?: unknown; error?: string }
  /**
   * Per-turn completion. Optional fields:
   *  - cost (USD): claude-code surfaces `result.total_cost_usd`; forgeax cli
   *    + codex don't currently emit cost. May be 0.
   *  - durationMs: server-side wall-clock per turn. claude-code surfaces
   *    `result.duration_ms`; forgeax cli + codex don't. UI falls back to
   *    a client-measured estimate (ForgeCard renders `⏱ ~Ns` prefix when
   *    using the fallback to distinguish provider-precise from estimate).
   */
  | {
      type: 'done';
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled';
      code?: string;
      cost?: number;
      durationMs?: number;
      /**
       * Per-turn token usage. Surfaced by claude-code (extracted from the
       * stream-json `assistant` snapshot or terminal `result` event); forgeax
       * cli + codex don't yet emit this. Optional + nullable individual fields
       * so providers can report whatever subset they have.
       */
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
    }
  /**
   * `code` is the structured machine-readable identifier for the failure
   * mode (Doc 05 section 7 lifecycle terminals: 'cancelled', 'driver-timeout',
   * driver-specific codes for spawn/exec failures). `message` stays as the
   * free-form human-readable detail.
   */
  | { type: 'error'; message: string; code?: string }
  /**
   * Raw EventBus StoredEvent passthrough (forgeax path only). The UI consumes
   * the original forgeax-cli-native event shape (ink-renderer-style
   * RendererMessage build via TurnAccumulator). claude-code / codex / cursor
   * paths keep emitting the legacy lossy variants (token / thinking / tool-*).
   * SSE wire: serialised as `event: stored-event`.
   */
  | { type: 'stored-event'; storedEvent: Record<string, unknown> }
) & { emitterId?: string; providerId?: ProviderId };

export interface ProviderCapabilities {
  /** tokens stream as they're generated */
  streaming: boolean;
  /** emits 'thinking' events */
  thinking: boolean;
  /** 'tool-call' / 'tool-result' pair */
  toolCalls: boolean;
  /** retained for /api/bus slim shape; sub-agent runtime is being rebuilt
   *  on agent-tree, so all providers currently report false. */
  subAgents: boolean;
  /** listSessions / getSessionEvents supported */
  sessions: boolean;
  /** session events are jsonl, replayable */
  jsonlReplay: boolean;
}

export interface ProviderConfig {
  /** Inject env values (API keys, base URLs) without reading process.env. */
  env?: Record<string, string>;
  /** Provider-specific config blob. */
  options?: Record<string, unknown>;
}

export interface SessionScope {
  instanceId: string;
  agentId: string;
}

export interface SessionInfo {
  id: string;
  mtime?: number;
  agentId: string;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

export interface CliProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  init(cfg: ProviderConfig): Promise<void>;
  shutdown(): Promise<void>;
  health(timeoutMs?: number): Promise<ProviderHealth>;

  /** Streams chat events. Caller passes AbortSignal for cancellation. */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;

  /**
   * Doc 05 section 7 -- abort an in-flight call by its caller-assigned id.
   * Implementations look up the per-call AbortController in their internal
   * map, call abort(), and resolve. Unknown / already-finished callIds resolve
   * silently (idempotent). Force-kill bounding (8s) is the route's job via
   * `cancelWithDeadline` from @forgeax/agent-runtime; this method only signals.
   */
  cancel?(callId: string): Promise<void>;

  // Sessions (optional)
  listSessions?(scope: SessionScope): Promise<SessionInfo[]>;
  getSessionEvents?(scope: SessionScope, sessionId?: string): Promise<string>;
  deleteSession?(scope: SessionScope, sessionId: string): Promise<void>;
}
