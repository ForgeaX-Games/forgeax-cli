// @desc OpenAI Responses API adapter — /v1/responses, SSE streaming, native multimodal tool output

import { registerProvider, downgradeEffort, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart, ReasoningEffort } from "../core/types.js";
import { isInlineMediaContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamEvent, SystemBlock } from "./types.js";
import { listSupported } from "./types.js";
import { parseSSE } from "./stream.js";
import { annotateLLMError, throwHttpApiError } from "./errors.js";
import { readMediaBytes, readFileBytes } from "./media-storage.js";
import { base64EncodedSize } from "./image-compression.js";
import { blocksToText, partitionSystemBlocks, foldDynamicReminders } from "./provider-utils.js";

/**
 * OpenAI Responses API adapter — `/v1/responses`.
 *
 * Wire-format notes (verified 2026-05-01, see
 * `team/shared-workspace/cache-experiment/findings-responses.md`):
 *
 *   - Top-level system goes into `instructions` (string). Both stable and
 *     dynamic blocks land here — stable head + `<system-reminder>` dynamic
 *     tail. Cache is byte-prefix matching across the entire request, so
 *     stable head still hits as long as it doesn't move; the `input` array
 *     stays byte-stable for prefix caching.
 *
 *   - History goes into `input: any[]`, an array of typed items:
 *       - `{role, content: [...]}` for user messages (content type tags
 *         use the `input_*` prefix — `input_text`, `input_image`, etc.)
 *       - `{type:"message", role:"assistant", content:[{type:"output_text", text}]}`
 *         for assistant text replay
 *       - `{type:"function_call", call_id, name, arguments}` for assistant
 *         tool calls (each call is a separate top-level item, NOT nested
 *         under the assistant message like chat-completions)
 *       - `{type:"function_call_output", call_id, output}` for tool results.
 *         `output` accepts both string AND content list — content list with
 *         `input_image` is supported natively (verified probe B), so tool
 *         returning images doesn't need the chat-completions follow-up
 *         user-message hack.
 *
 *   - Reasoning: server emits `reasoning` items in output, each with an
 *     `id`. Under `store=false` those ids are NOT persisted server-side;
 *     replaying them in a subsequent input array returns 404 ("Items not
 *     persisted"). So we do NOT emit `reasoning` items in the input array.
 *     The framework's `LLMMessage.thinking` is for ledger / UI display
 *     only. Probe C verified the model handles continuity via message
 *     context alone.
 *
 *   - SSE event names (verified probe A):
 *       response.created / response.in_progress
 *       response.output_item.added / .done
 *       response.content_part.added / .done
 *       response.output_text.delta / .done
 *       response.function_call_arguments.delta / .done   (underscores!)
 *       response.completed
 *
 *   - Sidecar key is `openai_response` (not `openai`) so the openai-compat
 *     extractMeta branch's `prompt_tokens` formula doesn't accidentally
 *     match the Responses' `input_tokens` shape and silently report 0%
 *     cache hit. Usage shape:
 *       {
 *         input_tokens, input_tokens_details: { cached_tokens },
 *         output_tokens, output_tokens_details: { reasoning_tokens },
 *         total_tokens
 *       }
 */

// ── MIME tables (mirrored from openai-compat for now; if this duplication
//    proves load-bearing in future, hoist to a shared module per P6) ──

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

const OPENAI_REQUEST_MAX_BYTES = 50 * 1024 * 1024;

class RequestBudget {
  private used = 0;
  charge(bytes: number): void { this.used += bytes; }
  canFit(bytes: number): boolean { return this.used + bytes <= OPENAI_REQUEST_MAX_BYTES; }
}

// ── ContentPart → Responses content shapes ──
//
// Two flavors of ContentPart conversion: `input_*` (used in user messages
// and tool result content lists) vs `output_text` (used when replaying an
// assistant message back to the API). Same source ContentPart, different
// type tags depending on which slot it occupies.

async function convertPartToInputContent(p: ContentPart, budget?: RequestBudget): Promise<any> {
  if (p.type === "text") {
    return { type: "input_text", text: p.text };
  }

  if (p.type === "text_file") {
    try {
      const { bytes, mimeType } = await readFileBytes(p);
      const b64Size = base64EncodedSize(bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "input_text", text: `[file omitted: request size would exceed 50 MB limit (${p.path})]` };
      }
      budget?.charge(b64Size);
      return {
        type: "input_file",
        filename: p.path,
        file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
      };
    } catch {
      return { type: "input_text", text: `[file unavailable: ${p.path}]` };
    }
  }

  if (p.type === "file") {
    // Read first so the supported-mime gate sees the sniff-corrected mime.
    let bytes: Buffer;
    let mimeType: string;
    try {
      ({ bytes, mimeType } = await readFileBytes(p));
    } catch {
      return { type: "input_text", text: `[file unavailable: ${p.path}]` };
    }
    if (!OPENAI_SUPPORTED_FILE_MIME_TYPES.has(mimeType)) {
      return { type: "input_text", text: `[file unsupported by OpenAI: ${p.path} (${mimeType})]` };
    }
    const b64Size = base64EncodedSize(bytes);
    if (budget && !budget.canFit(b64Size)) {
      return { type: "input_text", text: `[file omitted: request size would exceed 50 MB limit (${p.path})]` };
    }
    budget?.charge(b64Size);
    return {
      type: "input_file",
      filename: p.path,
      file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
    };
  }

  if (p.type === "image_file") {
    try {
      const loaded = await readMediaBytes(p);
      if (!OPENAI_SUPPORTED_IMAGE_MIME_TYPES.has(loaded.mimeType)) {
        return {
          type: "input_text",
          text: `[image: unsupported by OpenAI for mime ${loaded.mimeType}. Supported: ${listSupported(OPENAI_SUPPORTED_IMAGE_MIME_TYPES)}]`,
        };
      }
      const b64Size = base64EncodedSize(loaded.bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "input_text", text: `[image omitted: request size would exceed 50 MB limit (${p.path})]` };
      }
      budget?.charge(b64Size);
      return [
        { type: "input_text", text: `[file: ${p.path}]` },
        { type: "input_image", image_url: `data:${loaded.mimeType};base64,${loaded.bytes.toString("base64")}` },
      ];
    } catch {
      return { type: "input_text", text: `[image unavailable: ${p.path}]` };
    }
  }

  if (p.type === "audio_file") {
    // Responses API does not currently expose a dedicated input_audio type
    // for inline base64 audio in `input` arrays the way chat-completions
    // does. Degrade gracefully.
    return { type: "input_text", text: `[audio file: ${p.path} — Responses API does not yet accept inline audio input; transcribe before passing]` };
  }

  if (p.type === "video_file") {
    return { type: "input_text", text: `[video unsupported by OpenAI Responses: ${p.path}]` };
  }

  if (!isInlineMediaContentPart(p)) {
    return { type: "input_text", text: `[unknown content type]` };
  }

  switch (p.type) {
    case "image": {
      const { bytes, mimeType: sniffedMime } = await readMediaBytes(p);
      if (!OPENAI_SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMime)) {
        return {
          type: "input_text",
          text:
            `[image: unsupported by OpenAI Responses for mime ${sniffedMime}. ` +
            `Supported image MIME types: ${listSupported(OPENAI_SUPPORTED_IMAGE_MIME_TYPES)}]`,
        };
      }
      const b64Size = base64EncodedSize(bytes);
      if (budget && !budget.canFit(b64Size)) {
        return { type: "input_text", text: `[image omitted: request size would exceed 50 MB limit]` };
      }
      budget?.charge(b64Size);
      return {
        type: "input_image",
        image_url: `data:${sniffedMime};base64,${bytes.toString("base64")}`,
      };
    }
    case "audio":
      return { type: "input_text", text: `[inline audio: Responses API does not yet accept inline audio input — transcribe before passing]` };
    case "video":
      return { type: "input_text", text: `[video: unsupported by OpenAI Responses]` };
  }
}

async function inputContentList(parts: ContentPart[], budget?: RequestBudget): Promise<any[]> {
  const result: any[] = [];
  for (const p of parts) {
    const converted = await convertPartToInputContent(p, budget);
    if (Array.isArray(converted)) { result.push(...converted); }
    else { result.push(converted); }
  }
  return result;
}

// Assistant text replay uses `output_text` per the API's output mirror
// shape. We only ever construct text here — assistant tool calls and
// reasoning items are emitted as separate top-level input items.
function assistantContentList(parts: ContentPart[]): any[] | null {
  const out: any[] = [];
  for (const p of parts) {
    if (p.type === "text" && p.text.length > 0) {
      out.push({ type: "output_text", text: p.text });
    }
  }
  return out.length > 0 ? out : null;
}

// ── Tool definitions ──

function toolDefsToResponses(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

// ── messagesToResponseInput ──

/** Convert framework history into the Responses `input` array. Reasoning
 *  items are intentionally omitted (see file-level note + probe C). */
export async function messagesToResponseInput(messages: LLMMessage[]): Promise<any[]> {
  const result: any[] = [];
  const budget = new RequestBudget();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Group consecutive tool messages into function_call_output items.
    if (msg.role === "tool") {
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i];
        if (tm.toolStatus !== "pending") {
          const hasNonText = tm.content.some((p) => p.type !== "text");
          if (hasNonText) {
            // Native multimodal: emit content list (verified probe B).
            const contentList = await inputContentList(tm.content, budget);
            result.push({
              type: "function_call_output",
              call_id: tm.toolCallId ?? "_tool",
              output: contentList,
            });
          } else {
            // Plain text: keep as a single string for terseness.
            const text = tm.content
              .filter((p) => p.type === "text")
              .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
              .join("");
            budget.charge(Buffer.byteLength(text, "utf8"));
            result.push({
              type: "function_call_output",
              call_id: tm.toolCallId ?? "_tool",
              output: text,
            });
          }
        }
        i++;
      }
      i--;
      continue;
    }

    if (msg.role === "assistant") {
      // Emit visible text as a `message` item only when content is non-empty.
      const textContent = assistantContentList(msg.content);
      if (textContent) {
        result.push({
          type: "message",
          role: "assistant",
          content: textContent,
        });
      }
      // Emit each tool call as its own top-level function_call item.
      for (const tc of msg.toolCalls ?? []) {
        result.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
      // Reasoning intentionally not emitted — see file-level note.
      continue;
    }

    // user message
    result.push({
      role: "user",
      content: await inputContentList(msg.content, budget),
    });
  }
  return result;
}

// ── Stream parsing ──

interface OpenAIResponseSidecar {
  /** Raw `response.usage` object — full passthrough. Schema:
   *  `input_tokens`, `input_tokens_details.{cached_tokens, ...}`,
   *  `output_tokens`, `output_tokens_details.{reasoning_tokens, ...}`,
   *  `total_tokens`.
   *  Field name `usage_raw` (not `usage`) avoids collision with the
   *  framework outer `usage: { inputTokens, outputTokens }` aggregate. */
  usage_raw?: Record<string, unknown>;
  /** Server-issued response id — observability only; NOT consumed. */
  responseId?: string;
}

interface PendingToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

function responseStreamError(parsed: any): { code?: string; message: string; status?: number; raw?: unknown } {
  const response = parsed?.response as Record<string, unknown> | undefined;
  const error = (parsed?.error ?? response?.error) as Record<string, unknown> | undefined;
  const errType = typeof error?.type === "string" ? error.type : undefined;
  const code = (typeof error?.code === "string" && error.code) || errType;
  const message = typeof error?.message === "string" ? error.message : undefined;
  const status = errType === "invalid_request_error" || code === "context_length_exceeded" ? 400
    : errType === "rate_limit_error" || code === "rate_limit_exceeded" ? 429
    : undefined;
  if (message) return { code, message, status, raw: error };

  const raw = {
    type: parsed?.type,
    responseId: response?.id,
    status: response?.status,
    model: response?.model,
    reasoning: response?.reasoning,
    error,
    incomplete_details: response?.incomplete_details,
    content_filters: response?.content_filters,
  };
  const compact = JSON.stringify(raw);
  return {
    code,
    message: compact && compact !== "{}" ? compact.slice(0, 1200) : "Responses stream failed",
    status,
    raw,
  };
}

function throwResponseStreamError(parsed: any, model: string): never {
  const { code, message, status, raw } = responseStreamError(parsed);
  const err = new Error(`openai-responses stream error${code ? ` (${code})` : ""}: ${message}`);
  if (status) (err as any).status = status;
  if (raw) (err as any).responseError = raw;
  annotateLLMError(err, { provider: "openai-responses", model });
  throw err;
}

interface OpenAIResponseStreamOpts {
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  reasoningEffort?: import("../core/types.js").ReasoningEffort;
}

/** Drive a Responses stream and yield framework StreamEvents. */
export async function* openAIResponseStream(
  streamOpts: OpenAIResponseStreamOpts,
  system: SystemBlock[] | undefined,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const { stable } = partitionSystemBlocks(system ?? []);
  const instructions = stable.length ? blocksToText(stable) : undefined;
  const enrichedMessages = foldDynamicReminders(messages);

  const input = await messagesToResponseInput(enrichedMessages);
  const responseTools = toolDefsToResponses(tools);

  const body: Record<string, unknown> = {
    model: streamOpts.model,
    input,
    stream: true,
    store: false,
  };
  if (instructions) body.instructions = instructions;
  if (responseTools) body.tools = responseTools;
  if (streamOpts.maxTokens) body.max_output_tokens = streamOpts.maxTokens;
  if (streamOpts.reasoningEffort) {
    body.reasoning = {
      effort: streamOpts.reasoningEffort,
      summary: "auto",
    };
  }

  const res = await fetch(`${streamOpts.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${streamOpts.apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throwHttpApiError(res, text, "openai-responses", streamOpts.model);
  }

  // Track in-flight tool_calls by item id so SSE deltas can locate their
  // carrier and accumulate `arguments` until the matching `.done` event.
  const pendingCalls = new Map<string, PendingToolCall>();
  let responseId: string | undefined;
  let usageRaw: Record<string, unknown> | undefined;

  // Coalesce sub-token SSE deltas into chunks before yielding StreamEvents,
  // to avoid one-publish-per-token churn on the ledger / EventBus while
  // still feeling streamy in the UI. Flush on small-sentence size, or on
  // paragraph break (\n\n), or on the matching `.done` / `.completed`
  // event. Thinking gets a larger chunk because reasoning summaries are
  // dense paragraphs the user reads in bulk; user-facing text gets a
  // smaller chunk for tighter typing-cursor feel.
  const TEXT_FLUSH_CHARS = 80;
  const THINKING_FLUSH_CHARS = 160;
  let textBuffer = "";
  let thinkingBuffer = "";

  for await (const { event, data } of parseSSE(res)) {
    if (signal.aborted) break;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const type = event ?? parsed?.type;

    switch (type) {
      case "error":
      case "response.failed":
        throwResponseStreamError(parsed, streamOpts.model);

      case "response.created": {
        const r = parsed?.response;
        if (r && typeof r.id === "string") responseId = r.id;
        break;
      }

      case "response.output_item.added": {
        const item = parsed?.item;
        if (item?.type === "function_call" && typeof item.id === "string") {
          pendingCalls.set(item.id, {
            call_id: typeof item.call_id === "string" ? item.call_id : item.id,
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : "",
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const itemId = parsed?.item_id;
        const delta = parsed?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const pc = pendingCalls.get(itemId);
          if (pc) {
            pc.arguments += delta;
            yield {
              type: "tool_call_delta",
              id: pc.call_id,
              name: pc.name,
              arguments_delta: delta,
            };
          }
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const itemId = parsed?.item_id;
        const final = parsed?.arguments;
        if (typeof itemId === "string") {
          const pc = pendingCalls.get(itemId);
          if (pc) {
            if (typeof final === "string") pc.arguments = final;
            pendingCalls.delete(itemId);
            yield {
              type: "tool_call",
              id: pc.call_id,
              name: pc.name,
              arguments: pc.arguments,
            };
          }
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = parsed?.delta;
        if (typeof delta === "string" && delta.length > 0) {
          textBuffer += delta;
          if (textBuffer.length >= TEXT_FLUSH_CHARS || textBuffer.endsWith("\n\n")) {
            yield { type: "text", text: textBuffer };
            textBuffer = "";
          }
        }
        break;
      }

      case "response.output_text.done": {
        if (textBuffer) {
          yield { type: "text", text: textBuffer };
          textBuffer = "";
        }
        break;
      }

      // Reasoning summary streams — name varies across API revisions; match
      // by suffix to remain forward-compatible. We emit them as `thinking`
      // events for ledger/UI; we still don't replay them on subsequent
      // turns (see file-level note).
      default: {
        if (typeof type === "string" && type.startsWith("response.reasoning") && type.endsWith(".delta")) {
          const delta = parsed?.delta;
          if (typeof delta === "string" && delta.length > 0) {
            thinkingBuffer += delta;
            if (thinkingBuffer.length >= THINKING_FLUSH_CHARS || thinkingBuffer.endsWith("\n\n")) {
              yield { type: "thinking", text: thinkingBuffer };
              thinkingBuffer = "";
            }
          }
        } else if (typeof type === "string" && type.startsWith("response.reasoning") && type.endsWith(".done")) {
          if (thinkingBuffer) {
            yield { type: "thinking", text: thinkingBuffer };
            thinkingBuffer = "";
          }
        }
        break;
      }

      case "response.completed": {
        const r = parsed?.response ?? {};
        if (typeof r.id === "string") responseId = r.id;
        const usage = r.usage;
        if (usage && typeof usage === "object") {
          usageRaw = { ...(usage as Record<string, unknown>) };
        }
        if (thinkingBuffer) {
          yield { type: "thinking", text: thinkingBuffer };
          thinkingBuffer = "";
        }
        if (textBuffer) {
          yield { type: "text", text: textBuffer };
          textBuffer = "";
        }
        // Drain any function_calls that didn't get an explicit `.done`
        // event — defensive against future API event-set variation.
        for (const [, pc] of pendingCalls) {
          yield {
            type: "tool_call",
            id: pc.call_id,
            name: pc.name,
            arguments: pc.arguments,
          };
        }
        pendingCalls.clear();
        break;
      }
    }
  }

  // Emit sidecar + usage events at the tail.
  if (usageRaw || responseId) {
    const sidecar: OpenAIResponseSidecar = {};
    if (usageRaw) sidecar.usage_raw = usageRaw;
    if (responseId) sidecar.responseId = responseId;
    yield {
      type: "provider_sidecar",
      providerSidecarData: { openai_response: sidecar },
    };
  }
  if (usageRaw) {
    const inputTokens = typeof usageRaw.input_tokens === "number" ? usageRaw.input_tokens : 0;
    const outputTokens = typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : 0;
    yield { type: "usage", inputTokens, outputTokens };
  }
}

// ── Provider factory ──

export function normalizeBaseUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

/**
 * Per-model `reasoning.effort` ceiling.
 *
 * The Responses API top-level supported set is
 * `["minimal","low","medium","high","xhigh"]` (probe E confirms `max` is
 * never accepted — 400 "Invalid value: 'max'"). On top of that, smaller
 * variants (`*-mini`, `*-nano`) further cap the ceiling at `high`:
 * gpt-5-mini's 400 explicitly enumerates "Supported values are: 'minimal',
 * 'low', 'medium', and 'high'." Sending `xhigh` to a mini/nano model
 * raises 400 unsupported_value at runtime — better to cap framework-side
 * so framework `reasoningEffort: max` automatically lands on `high` for
 * mini/nano without the user having to override per-model.
 */
function supportedEffortsFor(model: string): readonly ReasoningEffort[] {
  if (/-(?:mini|nano)\b/i.test(model)) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["minimal", "low", "medium", "high", "xhigh"];
}

function createOpenAIResponseProvider(opts: ProviderFactoryOpts): LLMProvider {
  return {
    async prepareInboundMessages(messages, _context) {
      return messages;
    },
    async *chatStream(system, messages, tools, signal) {
      yield* openAIResponseStream(
        {
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.openai.com"),
          maxTokens: opts.maxTokens,
          // `downgradeEffort` walks the EFFORT_ORDER downward to the first
          // level present in the supported set. With user `reasoningEffort:
          // "max"` (admin's default) and a mini/nano model, this lands on
          // `high`; on a full-size model, it lands on `xhigh`.
          reasoningEffort: opts.reasoningEffort
            ? downgradeEffort(opts.reasoningEffort, supportedEffortsFor(opts.model))
            : undefined,
        },
        system,
        messages,
        tools,
        signal,
      );
    },
  };
}

registerProvider("openai-responses", createOpenAIResponseProvider);

export { createOpenAIResponseProvider };
