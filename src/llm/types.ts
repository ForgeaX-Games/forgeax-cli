import type { ContentPart } from '../core/types.js';

export function listSupported(values: Iterable<string>): string {
  return Array.from(values).join(", ");
}

export type ProviderSidecarData = Record<string, unknown>;

export interface SystemBlock {
  name: string;
  text: string;
  /** Cache hint — mirrors ContextSlot.cacheHint after slot pipeline resolution.
   *  - "stable"  — stable system prompt prefix (cache-friendly)
   *  - "dynamic" — changes per turn; lives after the cache marker
   *  When ContextSlot.cacheHint is omitted, this defaults to "dynamic". */
  cacheHint?: "stable" | "dynamic";
  priority: number;
}

export interface LLMMessage {
  role: "user" | "assistant" | "tool" | "system";
  /** Normalized content for provider consumption — always ContentPart[].
   *  Event/storage layer may keep raw strings; normalization happens when
   *  constructing LLMMessage (replay / bind / prepareInboundMessages). */
  content: ContentPart[];
  thinking?: string;
  truncated?: boolean;
  ts?: number;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "pending" | "completed" | "failed" | "synthetic" | "interrupted";
  toolCalls?: LLMToolCall[];
  providerSidecarData?: ProviderSidecarData;
  /** Structured system blocks carried by role:"system" dynamic-reminder messages. */
  systemBlocks?: SystemBlock[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerSidecarData?: ProviderSidecarData;
}

export interface LLMResponse {
  content: string | ContentPart[];
  thinking?: string;
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Framework/catalog model used for this response, not provider-returned version ids. */
  model?: string;
  /** True when the response was cut short by an AbortSignal mid-stream. */
  truncated?: boolean;
  providerSidecarData?: ProviderSidecarData;
}

/** All event types yielded by provider chatStream — internal to the streaming pipeline. */
export type StreamEvent =
  | { type: "text"; text: string; providerSidecarData?: ProviderSidecarData }
  | { type: "thinking"; text: string; providerSidecarData?: ProviderSidecarData }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
      providerSidecarData?: ProviderSidecarData;
    }
  | {
      type: "tool_call_delta";
      id: string;
      name: string;
      arguments_delta: string;
    }
  | { type: "provider_sidecar"; providerSidecarData: ProviderSidecarData }
  | { type: "usage"; inputTokens: number; outputTokens: number; model?: string };

export interface PrepareInboundMessagesContext {
  signal: AbortSignal;
}

export interface MaterializeAssistantMessageOptions {
  showThinking: boolean;
  ts: number;
  truncated?: boolean;
}

export interface MaterializeToolMessagesOptions {
  ts: number;
}

export interface LLMProvider {
  chatStream(
    system: SystemBlock[] | undefined,
    messages: LLMMessage[],
    tools: import('../core/types.js').ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;

  /** Provider-specific pre-processing hook.
   * Use this for adapter-specific enrichment (e.g. Gemini file refs), not as the generic
   * string -> ContentPart[] normalization entrypoint. */
  prepareInboundMessages?(
    messages: LLMMessage[],
    context: PrepareInboundMessagesContext,
  ): Promise<LLMMessage[]>;

  materializeAssistantMessage?(
    response: LLMResponse,
    options: MaterializeAssistantMessageOptions,
  ): LLMMessage;

  materializePendingToolMessages?(
    toolCalls: LLMToolCall[],
    options: MaterializeToolMessagesOptions,
  ): LLMMessage[];

  /** Returns the tool_result LLMMessage. Synchronous — media hygiene is now
   *  handled at the storage layer (event-blob.ts size-based externalize on
   *  WAL write, media-storage.ts magic-byte mime sniff on file read), not at
   *  this seam. */
  materializeToolResult?(
    toolCall: LLMToolCall,
    result: unknown,
    options: MaterializeToolMessagesOptions,
  ): LLMMessage;
}
