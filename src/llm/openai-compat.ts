/** OpenAI Chat Completions adapter — SSE streaming, multimodal */

import { registerProvider, downgradeEffort, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart, ReasoningEffort } from "../core/types.js";
import { isInlineMediaContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamEvent, SystemBlock } from "./types.js";
import { listSupported } from "./types.js";
import { parseSSE } from "./stream.js";
import { annotateLLMError, throwHttpApiError } from "./errors.js";
import { readMediaBytes, readFileBytes } from "./media-storage.js";
import { base64EncodedSize } from "./image-compression.js";
import { blocksToText } from "./provider-utils.js";
import { partitionSystemBlocks, foldDynamicReminders } from "./provider-utils.js";

// OpenAI image input keeps the original MIME in a data URL, while audio input
// uses a provider-specific `format` enum. We still model both as explicit
// provider capability tables so unsupported MIME types can degrade cleanly.
const OPENAI_AUDIO_FORMAT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/m4a": "mp4",
};
const OPENAI_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const OPENAI_SUPPORTED_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const OPENAI_REQUEST_MAX_BYTES = 50 * 1024 * 1024; // per-request combined file size limit (text messages excluded)

class RequestBudget {
  private used = 0;
  charge(bytes: number): void { this.used += bytes; }
  canFit(bytes: number): boolean { return this.used + bytes <= OPENAI_REQUEST_MAX_BYTES; }
}

export function toolDefsToOpenAI(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export async function contentToOpenAI(content: ContentPart[], budget?: RequestBudget): Promise<any[]> {
  const result: any[] = [];
  for (const p of content) {
    const converted = await convertPartToOpenAI(p, budget);
    if (Array.isArray(converted)) { result.push(...converted); }
    else { result.push(converted); }
  }
  return result;
}

async function convertPartToOpenAI(p: ContentPart, budget?: RequestBudget): Promise<any> {
  if (p.type === "text") {
    return { type: "text", text: p.text };
  }

  if (p.type === "text_file") {
    try {
      const { bytes, mimeType } = await readFileBytes(p);
      const b64Size = base64EncodedSize(bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "text", text: `[file omitted: request size would exceed 50 MB limit (${p.path})]` };
      }
      budget?.charge(b64Size);
      return {
        type: "file",
        file: {
          filename: p.path,
          file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
        },
      };
    } catch {
      return { type: "text", text: `[file unavailable: ${p.path}]` };
    }
  }

  if (p.type === "file") {
    // Read first so the supported-mime gate sees the sniff-corrected mime.
    let bytes: Buffer;
    let mimeType: string;
    try {
      ({ bytes, mimeType } = await readFileBytes(p));
    } catch {
      return { type: "text", text: `[file unavailable: ${p.path}]` };
    }
    if (!OPENAI_SUPPORTED_FILE_MIME_TYPES.has(mimeType)) {
      return { type: "text", text: `[file unsupported by OpenAI: ${p.path} (${mimeType})]` };
    }
    const b64Size = base64EncodedSize(bytes);
    if (budget && !budget.canFit(b64Size)) {
      return { type: "text", text: `[file omitted: request size would exceed 50 MB limit (${p.path})]` };
    }
    budget?.charge(b64Size);
    return {
      type: "file",
      file: {
        filename: p.path,
        file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
      },
    };
  }

  if (p.type === "image_file") {
    try {
      const loaded = await readMediaBytes(p);
      if (!OPENAI_SUPPORTED_IMAGE_MIME_TYPES.has(loaded.mimeType)) {
        return {
          type: "text",
          text: `[image: unsupported by OpenAI for mime ${loaded.mimeType}. Supported: ${listSupported(OPENAI_SUPPORTED_IMAGE_MIME_TYPES)}]`,
        };
      }
      const b64Size = base64EncodedSize(loaded.bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "text", text: `[image omitted: request size would exceed 50 MB limit (${p.path})]` };
      }
      budget?.charge(b64Size);
      return [
        { type: "text", text: `[file: ${p.path}]` },
        { type: "image_url", image_url: { url: `data:${loaded.mimeType};base64,${loaded.bytes.toString("base64")}` } },
      ];
    } catch {
      return { type: "text", text: `[image unavailable: ${p.path}]` };
    }
  }

  if (p.type === "audio_file") {
    try {
      const loaded = await readMediaBytes(p);
      if (!(loaded.mimeType in OPENAI_AUDIO_FORMAT_BY_MIME)) {
        return {
          type: "text",
          text: `[audio: unsupported by OpenAI for mime ${loaded.mimeType}. Supported: ${listSupported(Object.keys(OPENAI_AUDIO_FORMAT_BY_MIME))}]`,
        };
      }
      const b64Size = base64EncodedSize(loaded.bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "text", text: `[audio omitted: request size would exceed 50 MB limit (${p.path})]` };
      }
      budget?.charge(b64Size);
      return [
        { type: "text", text: `[file: ${p.path}]` },
        { type: "input_audio", input_audio: { data: loaded.bytes.toString("base64"), format: OPENAI_AUDIO_FORMAT_BY_MIME[loaded.mimeType] } },
      ];
    } catch {
      return { type: "text", text: `[audio unavailable: ${p.path}]` };
    }
  }

  if (p.type === "video_file") {
    return { type: "text", text: `[video unsupported by OpenAI: ${p.path}]` };
  }

  if (!isInlineMediaContentPart(p)) {
    return { type: "text", text: `[unknown content type]` };
  }

  switch (p.type) {
    case "image": {
      // Sniff inline bytes via readMediaBytes so dirty mime (e.g. JPEG bytes
      // declared image/png) gets corrected — same hygiene path as image_file.
      const { bytes, mimeType: sniffedMime } = await readMediaBytes(p);
      if (!OPENAI_SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMime)) {
        return {
          type: "text",
          text:
            `[image: unsupported by OpenAI chat adapter for mime ${sniffedMime}. ` +
            `Supported image MIME types: ${listSupported(OPENAI_SUPPORTED_IMAGE_MIME_TYPES)}]`,
        };
      }
      const b64Size = base64EncodedSize(bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "text", text: `[image omitted: request size would exceed 50 MB limit]` };
      }
      budget?.charge(b64Size);
      return {
        type: "image_url",
        image_url: { url: `data:${sniffedMime};base64,${bytes.toString("base64")}` },
      };
    }
    case "audio": {
      // Sniff inline bytes via readMediaBytes so dirty mime (e.g. MP3 bytes
      // declared audio/wav) gets corrected — same hygiene path as image.
      const { bytes, mimeType: sniffedMime } = await readMediaBytes(p);
      if (!(sniffedMime in OPENAI_AUDIO_FORMAT_BY_MIME)) {
        return {
          type: "text",
          text:
            `[audio: unsupported by OpenAI chat adapter for mime ${sniffedMime}. ` +
            `Supported audio MIME types: ${listSupported(Object.keys(OPENAI_AUDIO_FORMAT_BY_MIME))}]`,
        };
      }
      const b64Size = base64EncodedSize(bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "text", text: `[audio omitted: request size would exceed 50 MB limit]` };
      }
      budget?.charge(b64Size);
      return {
        type: "input_audio",
        input_audio: {
          data: bytes.toString("base64"),
          format: OPENAI_AUDIO_FORMAT_BY_MIME[sniffedMime],
        },
      };
    }
    case "video":
      return {
        type: "text",
        text:
          `[video: unsupported by OpenAI chat adapter. ` +
          `This adapter currently supports image MIME types ${listSupported(OPENAI_SUPPORTED_IMAGE_MIME_TYPES)} ` +
          `and audio MIME types ${listSupported(Object.keys(OPENAI_AUDIO_FORMAT_BY_MIME))}]`,
      };
  }
}

/**
 * Optional per-assistant-message transform hook — lets a provider extension enrich the
 * API-shaped assistant message with extra fields (e.g. DeepSeek V4 requires `reasoning_content`
 * to be replayed back to the API on assistant turns that carry tool_calls).
 */
export type OpenAIAssistantTransform = (
  apiMsg: Record<string, unknown>,
  srcMsg: LLMMessage,
) => void;

function toolResultText(msg: LLMMessage): string {
  const text = msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
    .join("");
  if (text.trim().length > 0) return text;

  const attachmentCount = msg.content.filter((p) => p.type !== "text").length;
  return attachmentCount > 0
    ? `[Tool result contains ${attachmentCount} non-text attachment(s); see following user message.]`
    : "";
}

async function appendToolMediaUserMessage(
  result: any[],
  toolMessages: LLMMessage[],
  budget: RequestBudget,
): Promise<void> {
  const content: any[] = [];
  for (const msg of toolMessages) {
    const attachments = msg.content.filter((p) => p.type !== "text");
    if (attachments.length === 0) continue;

    content.push({
      type: "text",
      text: `Media returned by ${msg.toolName ?? "tool"} (${msg.toolCallId ?? "unknown"}):`,
    });
    content.push(...await contentToOpenAI(attachments, budget));
  }

  if (content.length > 0) {
    result.push({ role: "user", content });
  }
}

export async function messagesToOpenAI(
  messages: LLMMessage[],
  system?: SystemBlock[],
  assistantTransform?: OpenAIAssistantTransform,
): Promise<any[]> {
  const result: any[] = [];
  const budget = new RequestBudget();

  if (system?.length) {
    const sysText = blocksToText(system);
    budget.charge(Buffer.byteLength(sysText, "utf8"));
    result.push({ role: "system", content: sysText });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") {
      const toolMessages: LLMMessage[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const toolMsg = messages[i];
        if (toolMsg.toolStatus !== "pending") {
          const toolText = toolResultText(toolMsg);
          budget.charge(Buffer.byteLength(toolText, "utf8"));
          result.push({
            role: "tool",
            tool_call_id: toolMsg.toolCallId ?? "_tool",
            content: toolText,
          });
          toolMessages.push(toolMsg);
        }
        i++;
      }
      await appendToolMediaUserMessage(result, toolMessages, budget);
      i--;
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const assistantMsg: Record<string, unknown> = { role: "assistant" };
      if (msg.content) assistantMsg.content = await contentToOpenAI(msg.content, budget);
      assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      assistantTransform?.(assistantMsg, msg);
      result.push(assistantMsg);
      continue;
    }

    const generic: Record<string, unknown> = {
      role: msg.role,
      content: await contentToOpenAI(msg.content, budget),
    };
    if (msg.role === "assistant") assistantTransform?.(generic, msg);
    result.push(generic);
  }
  return result;
}

// ── Model-family feature detection ──

/**
 * Does this OpenAI-compatible model require `max_completion_tokens` instead of `max_tokens`?
 *
 * OpenAI's 2025+ families (GPT-5 series, o1, o3, o4-mini) reject the legacy `max_tokens`
 * field outright. Azure's GPT-5 deployments share the same requirement. Older models
 * (GPT-4o, DeepSeek V3/V4, Qwen, etc.) still accept `max_tokens`.
 *
 * Match is case-insensitive and matches at the start of the model string so deployment
 * name prefixes (e.g. `gpt-5.4-mini-2026-03-17`) work automatically.
 */
function usesCompletionTokensField(model: string): boolean {
  return /^(gpt-5|o1|o3|o4-mini)/i.test(model);
}

/**
 * New reasoning model families only accept their default sampling settings.
 * Sending the framework fallback temperature (0.7) makes Azure/OpenAI reject
 * the request with "Only the default (1) value is supported".
 */
function disallowsTemperatureField(model: string): boolean {
  return /^(gpt-5|o1|o3|o4-mini)/i.test(model);
}

/**
 * Does this OpenAI-compatible model reject `reasoning_effort` when `tools` are also
 * present in a `/v1/chat/completions` request?
 *
 * OpenAI/Azure GPT-5 series (gpt-5.2 / 5.4 / 5.4-mini / 5.5) hard-block this combo
 * with HTTP 400:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.x in
 *    /v1/chat/completions. Please use /v1/responses instead."
 *
 * Migrating to the Responses API is a large adapter rewrite (different payload
 * schema, separate provider). Until that lands, we silently drop the
 * `reasoning_effort` field for these models when tools are attached so the call
 * still succeeds — tools take priority over reasoning hints in agentic flows.
 *
 * Tool-less reasoning calls on the same models are unaffected (the field is
 * still sent and respected by the model).
 */
function disallowsReasoningEffortWithTools(model: string, hasTools: boolean): boolean {
  return hasTools && /^gpt-5/i.test(model);
}

// ── Shared streaming logic (reused by deepseek-v4) ──

/** OpenAI-compat sidecar shape stored on assistant messages. Stores the raw usage object
 *  from the final stream chunk verbatim — no field enumeration, so new API fields and
 *  provider-specific extensions (e.g. DeepSeek's `prompt_cache_hit_tokens`) are captured
 *  automatically. Downstream analytics (cache hit rate, reasoning ratio, modality split)
 *  read raw fields directly from `usage`. */
interface OpenAICompatSidecar {
  /** Raw OpenAI-compat API usage object — full passthrough. Schema: `prompt_tokens`,
   *  `completion_tokens`, `total_tokens`, `prompt_tokens_details.{cached_tokens,
   *  audio_tokens, …}`, `completion_tokens_details.{reasoning_tokens, …}`, plus
   *  provider-specific top-level fields (DeepSeek `prompt_cache_hit_tokens` /
   *  `prompt_cache_miss_tokens`).
   *  Named `usage_raw` (not `usage`) to avoid collision with the framework-level
   *  outer `usage: { inputTokens, outputTokens }` standardized aggregate. */
  usage_raw?: Record<string, unknown>;
}

export interface OpenAIStreamOpts {
  providerName?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  extractReasoning?: boolean;
  /** Extra top-level body fields merged into the request (provider-specific extensions,
   *  e.g. DeepSeek V4's `thinking: {type: "enabled" | "disabled"}`). */
  extraBody?: Record<string, unknown>;
  /** Optional transform applied to each assistant message's API form before sending —
   *  for providers that require extra fields (e.g. DeepSeek V4 `reasoning_content` replay). */
  assistantTransform?: OpenAIAssistantTransform;
}

export async function* openAICompatStream(
  streamOpts: OpenAIStreamOpts,
  system: SystemBlock[] | undefined,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // Partition system into stable (goes into the system role message[0]) and
  // dynamic (appended as a fresh trailing user message carrying a single
  // <system-reminder> block). OpenAI/DeepSeek implicit prefix cache treats
  // the resulting input as a byte stream — by keeping the system message
  // stable and putting dynamic in its OWN trailing user message, every byte
  // before the reminder (including all tool turns) stays cache-eligible
  // across calls regardless of how the conversation tail looked previously.
  const { stable } = partitionSystemBlocks(system ?? []);
  const enrichedMessages = foldDynamicReminders(messages);

  const openaiMessages = await messagesToOpenAI(enrichedMessages, stable.length ? stable : undefined, streamOpts.assistantTransform);
  const openaiTools = toolDefsToOpenAI(tools);

  const body: any = {
    model: streamOpts.model,
    messages: openaiMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(streamOpts.extraBody ?? {}),
  };
  if (!disallowsTemperatureField(streamOpts.model)) {
    body.temperature = streamOpts.temperature;
  }
  if (streamOpts.maxTokens) {
    // OpenAI's GPT-5 / o1 / o3 / o4-mini families reject the legacy `max_tokens` field and
    // require `max_completion_tokens`. Azure's GPT-5 deployments behave the same. Older
    // OpenAI-compatible backends (GPT-4o, DeepSeek, Qwen, …) still want `max_tokens`.
    // Per-model dispatch keeps one shared stream and avoids forking a new provider.
    const field = usesCompletionTokensField(streamOpts.model)
      ? "max_completion_tokens"
      : "max_tokens";
    body[field] = streamOpts.maxTokens;
  }
  if (openaiTools) body.tools = openaiTools;
  if (
    streamOpts.reasoningEffort &&
    !disallowsReasoningEffortWithTools(streamOpts.model, !!openaiTools)
  ) {
    body.reasoning_effort = streamOpts.reasoningEffort;
  }

  const res = await fetch(`${streamOpts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${streamOpts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throwHttpApiError(res, text, streamOpts.providerName ?? "openai-compat", streamOpts.model);
  }
  const response = res;

  const pendingToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const { data } of parseSSE(response)) {
    if (data === "[DONE]") break;
    if (signal.aborted) break;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    // Usage check is INDEPENDENT of choice presence:
    //   - OpenAI: emits a separate trailing chunk with `choices: []` + usage
    //   - DeepSeek V4: piggybacks usage onto the final finish_reason chunk
    //     (i.e. the chunk has BOTH a non-empty `choices[0]` AND a top-level
    //     `usage`). Pre-fix this branch was gated on `!choice` so DeepSeek's
    //     usage was silently dropped, breaking sidecar capture and cache hit
    //     observability for any openai-compat-routed provider that bundles
    //     usage with the final delta chunk.
    if (parsed.usage && typeof parsed.usage === "object") {
      const usage = parsed.usage as Record<string, unknown>;
      const sidecarData: OpenAICompatSidecar = { usage_raw: usage };
      yield {
        type: "provider_sidecar",
        providerSidecarData: { openai: sidecarData },
      };
      const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
      yield {
        type: "usage",
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      };
    }

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (!delta) continue;

    if (streamOpts.extractReasoning && delta.reasoning_content) {
      yield { type: "thinking", text: delta.reasoning_content };
    }

    if (delta.content) {
      yield { type: "text", text: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!pendingToolCalls.has(idx)) {
          pendingToolCalls.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: "",
          });
        }
        const pending = pendingToolCalls.get(idx)!;
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) {
          pending.arguments += tc.function.arguments;
          yield {
            type: "tool_call_delta",
            id: pending.id,
            name: pending.name,
            arguments_delta: tc.function.arguments,
          };
        }
      }
    }

    if (
      choice.finish_reason === "tool_calls" ||
      choice.finish_reason === "stop"
    ) {
      for (const [, tc] of pendingToolCalls) {
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
      }
      pendingToolCalls.clear();
    }
  }

  for (const [, tc] of pendingToolCalls) {
    yield {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }
}

// ── Provider factory ──

export function normalizeBaseUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

function createOpenAICompatProvider(opts: ProviderFactoryOpts): LLMProvider {
  return {
    async prepareInboundMessages(messages, _context) {
      return messages;
    },
    async *chatStream(system, messages, tools, signal) {
      yield* openAICompatStream(
        {
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.openai.com"),
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens,
          reasoningEffort: opts.reasoningEffort
            ? downgradeEffort(opts.reasoningEffort, ["low", "medium", "high", "xhigh"])
            : undefined,
          extractReasoning: !!opts.reasoningEffort,
        },
        system,
        messages,
        tools,
        signal,
      );
    },
  };
}

registerProvider("openai-compat", createOpenAICompatProvider);

export { createOpenAICompatProvider };
