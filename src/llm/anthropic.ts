/** Anthropic Messages API adapter — SSE streaming, raw fetch, thinking support */

import { registerProvider, downgradeEffort, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamEvent, SystemBlock } from "./types.js";
import { listSupported } from "./types.js";
import { parseSSE } from "./stream.js";
import { annotateLLMError, throwHttpApiError } from "./errors.js";
import { readMediaBytes, readFileBytes } from "./media-storage.js";
import {
  base64EncodedSize,
  fitImageToPolicy,
  exceedsImageLimit,
  exceedsImageDimensions,
  describeImageLimit,
  describeImageSize,
  type ImagePreflightPolicy,
} from "./image-compression.js";
import { partitionSystemBlocks, foldDynamicReminders } from "./provider-utils.js";

type AnthropicAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface AnthropicSidecar {
  contentBlocks: AnthropicAssistantBlock[];
  /** Raw Anthropic API usage object — full passthrough, not enumerated. Merged from
   *  `message_start.message.usage` (input/cache/service_tier fields) +
   *  `message_delta.usage` (output_tokens delta). New API fields automatically captured.
   *  Schema: see Anthropic Messages API docs (input_tokens, output_tokens,
   *  cache_read_input_tokens, cache_creation_input_tokens, cache_creation,
   *  service_tier, …).
   *  Named `usage_raw` (not `usage`) to avoid collision with the framework-level
   *  outer `usage: { inputTokens, outputTokens }` standardized aggregate. */
  usage_raw?: Record<string, unknown>;
}

/**
 * Detect models that require adaptive-only thinking and reject sampling parameters.
 * Matches claude-opus-4-7, claude-opus-4-7-20260416, and any future opus >= 4.7.
 */
function isAdaptiveOnlyModel(model: string): boolean {
  const match = model.match(/claude-opus-(\d+)-(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > 4 || (major === 4 && minor >= 7);
}

const ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ANTHROPIC_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;

const ANTHROPIC_SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
]);

const IMAGE_POLICY: ImagePreflightPolicy = {
  maxBase64Bytes: ANTHROPIC_IMAGE_MAX_BASE64_BYTES,
  maxLongEdge: 2000,
  compressOversized: true,
  supportedMimeTypes: ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES,
};

function toolDefsToAnthropic(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

async function contentToAnthropic(content: ContentPart[]): Promise<any[]> {
  const result: any[] = [];
  for (const p of content) {
    const converted = await convertPartToAnthropic(p);
    if (Array.isArray(converted)) {
      result.push(...converted);
    } else {
      result.push(converted);
    }
  }
  return result;
}

async function convertPartToAnthropic(p: ContentPart): Promise<any | any[]> {
  if (p.type === "text") {
    if (p.text.length === 0) return [];
    return { type: "text", text: p.text };
  }

  if (p.type === "text_file") {
    try {
      const { bytes, mimeType } = await readFileBytes(p);
      if (mimeType === "text/plain") {
        return [
          { type: "text", text: `[file: ${p.path}]` },
          { type: "document", source: { type: "base64", media_type: "text/plain", data: bytes.toString("base64") } },
        ];
      }
      return { type: "text", text: `[file: ${p.path}]\n${bytes.toString("utf8")}` };
    } catch {
      return { type: "text", text: `[file unavailable: ${p.path}]` };
    }
  }

  if (p.type === "file") {
    // Read first to let readFileBytes sniff-correct mime; gate uses corrected
    // mime so PDF bytes declared application/octet-stream still get routed to
    // the document path instead of being rejected by a declared-mime gate.
    let bytes: Buffer;
    let mimeType: string;
    try {
      ({ bytes, mimeType } = await readFileBytes(p));
    } catch {
      return { type: "text", text: `[file unavailable: ${p.path}]` };
    }
    if (!ANTHROPIC_SUPPORTED_DOCUMENT_MIME_TYPES.has(mimeType)) {
      return { type: "text", text: `[file unsupported by Anthropic: ${p.path} (${mimeType})]` };
    }
    return [
      { type: "text", text: `[file: ${p.path}]` },
      { type: "document", source: { type: "base64", media_type: mimeType, data: bytes.toString("base64") } },
    ];
  }

  if (p.type === "image_file") {
    try {
      const loaded = await readMediaBytes(p);
      const img = await convertInlineImageToAnthropic(loaded.bytes, loaded.mimeType, loaded.label);
      return [{ type: "text", text: `[file: ${p.path}]` }, img];
    } catch {
      return { type: "text", text: `[image unavailable: ${p.path}]` };
    }
  }

  if (p.type === "audio_file" || p.type === "video_file") {
    const mediaType = p.type.replace("_file", "");
    return { type: "text", text: `[${mediaType} unsupported by Anthropic: ${p.path}]` };
  }

  if (p.type === "image") {
    // Use readMediaBytes so inline mime gets sniff-corrected (single dispatch
    // point for media bytes — same hygiene path as image_file).
    const { bytes, mimeType } = await readMediaBytes(p);
    return await convertInlineImageToAnthropic(bytes, mimeType, `inline image`);
  }

  if (p.type === "video" || p.type === "audio") {
    return {
      type: "text",
      text:
        `[${p.type}: unsupported by Anthropic messages API. ` +
        `This API currently supports image MIME types ${listSupported(ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES)}]`,
    };
  }

  return { type: "text", text: `[unknown content type]` };
}

async function convertInlineImageToAnthropic(
  bytes: Buffer,
  mimeType: string,
  label: string,
): Promise<any> {
  if (!ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      type: "text",
      text:
        `[image: unsupported by Anthropic messages API for mime ${mimeType}. ` +
        `Supported image MIME types: ${listSupported(ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES)}]`,
    };
  }

  if (!exceedsImageLimit(bytes, IMAGE_POLICY) && !(await exceedsImageDimensions(bytes, IMAGE_POLICY))) {
    return {
      type: "image",
      source: { type: "base64", media_type: mimeType, data: bytes.toString("base64") },
    };
  }

  if (IMAGE_POLICY.compressOversized) {
    const normalized = await fitImageToPolicy(bytes, mimeType, IMAGE_POLICY);
    if (normalized && !exceedsImageLimit(normalized.bytes, IMAGE_POLICY)) {
      return {
        type: "image",
        source: { type: "base64", media_type: normalized.mimeType, data: normalized.bytes.toString("base64") },
      };
    }
  }

  return {
    type: "text",
    text:
      `[image omitted: Anthropic image limit is ${describeImageLimit(IMAGE_POLICY)} ` +
      `and ${label} is ${describeImageSize(bytes)}]`,
  };
}

function toAnthropicSidecar(sidecarData: LLMMessage["providerSidecarData"]): AnthropicSidecar | null {
  const raw = sidecarData?.anthropic;
  if (!raw || typeof raw !== "object") return null;
  const contentBlocks = (raw as { contentBlocks?: unknown }).contentBlocks;
  if (!Array.isArray(contentBlocks)) return null;

  const normalized = contentBlocks.flatMap((block): AnthropicAssistantBlock[] => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    switch (item.type) {
      case "text":
        return typeof item.text === "string" && item.text.length > 0
          ? [{ type: "text", text: item.text }]
          : [];
      case "thinking":
        return typeof item.thinking === "string"
          ? [{
              type: "thinking",
              thinking: item.thinking,
              signature: typeof item.signature === "string" ? item.signature : undefined,
            }]
          : [];
      case "redacted_thinking":
        return typeof item.data === "string"
          ? [{ type: "redacted_thinking", data: item.data }]
          : [];
      case "tool_use":
        return typeof item.id === "string" &&
          typeof item.name === "string" &&
          item.input &&
          typeof item.input === "object" &&
          !Array.isArray(item.input)
          ? [{
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: item.input as Record<string, unknown>,
            }]
          : [];
      default:
        return [];
    }
  });

  return normalized.length > 0 ? { contentBlocks: normalized } : null;
}

function anthropicBlocksToApi(blocks: AnthropicAssistantBlock[]): any[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      default:
        return block;
    }
  });
}

async function fallbackAssistantBlocks(msg: LLMMessage): Promise<any[]> {
  const blocks: any[] = [];
  if (msg.content) {
    const c = await contentToAnthropic(msg.content);
    blocks.push(...c);
  }
  for (const tc of msg.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.arguments,
    });
  }
  return blocks;
}

async function assistantMessageToAnthropicContent(msg: LLMMessage): Promise<any[]> {
  const sidecar = toAnthropicSidecar(msg.providerSidecarData);
  if (sidecar?.contentBlocks.length) {
    return anthropicBlocksToApi(sidecar.contentBlocks);
  }
  return fallbackAssistantBlocks(msg);
}

async function messagesToAnthropic(messages: LLMMessage[]): Promise<any[]> {
  const result: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      const toolBlocks: any[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        if (toolMsg.toolStatus !== "pending") {
          toolBlocks.push({
            type: "tool_result",
            tool_use_id: toolMsg.toolCallId ?? "_tool",
            content: await contentToAnthropic(toolMsg.content),
          });
        }
        j++;
      }
      if (toolBlocks.length > 0) {
        result.push({
          role: "user",
          content: toolBlocks,
        });
      }
      i = j - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = await assistantMessageToAnthropicContent(msg);
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    result.push({
      role: "user",
      content: await contentToAnthropic(msg.content),
    });
  }
  return result;
}

function systemBlocksToAnthropic(blocks: SystemBlock[]): any[] {
  return blocks.map((block, i, arr) => {
    const entry: any = { type: "text", text: block.text };
    const nextIsNotStable = i === arr.length - 1 || arr[i + 1].cacheHint !== "stable";
    if (block.cacheHint === "stable" && nextIsNotStable) {
      entry.cache_control = { type: "ephemeral" };
    }
    return entry;
  });
}

function annotateMessageCache(messages: any[]): void {
  let lastUserIdx = -1;
  let secondLastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      if (lastUserIdx === -1) lastUserIdx = i;
      else if (secondLastUserIdx === -1) { secondLastUserIdx = i; break; }
    }
  }
  if (secondLastUserIdx >= 0) {
    const content = messages[secondLastUserIdx].content;
    if (Array.isArray(content) && content.length > 0) {
      // Skip trailing <system-reminder> blocks — they carry per-turn changing
      // dynamic bytes. Cache marker B should land on the last real-content
      // block so dynamic byte changes stay outside the cache prefix.
      let markerIdx = content.length - 1;
      while (
        markerIdx >= 0 &&
        content[markerIdx]?.type === "text" &&
        content[markerIdx]?.text?.startsWith("<system-reminder>")
      ) {
        markerIdx--;
      }
      if (markerIdx >= 0) {
        content[markerIdx] = {
          ...content[markerIdx],
          cache_control: { type: "ephemeral" },
        };
      }
    }
  }
}

function createAnthropicProvider(opts: ProviderFactoryOpts): LLMProvider {
  const { apiKey, baseUrl } = opts;
  const base = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const model = opts.model;
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;
  const reasoningEffort = opts.reasoningEffort;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
  };

  return {
    async prepareInboundMessages(messages, _context) {
      return messages;
    },
    async *chatStream(system, messages, tools, signal) {
      // Partition system into stable (system field) + dynamic (appended as a
      // fresh trailing user message carrying a single <system-reminder> block).
      // The reminder lives in its OWN message so the dynamic byte changes
      // never sit inside the cache prefix — marker B (placed on the
      const { stable } = partitionSystemBlocks(system ?? []);
      const enrichedMessages = foldDynamicReminders(messages);

      const anthropicMessages = await messagesToAnthropic(enrichedMessages);
      const anthropicTools = toolDefsToAnthropic(tools);

      const body: any = {
        model,
        messages: anthropicMessages,
        max_tokens: maxTokens,
        stream: true,
      };
      if (stable.length) {
        body.system = systemBlocksToAnthropic(stable);
      }
      annotateMessageCache(anthropicMessages);
      if (anthropicTools) body.tools = anthropicTools;

      if (isAdaptiveOnlyModel(model)) {
        // Opus 4.7+: adaptive thinking only, no sampling parameters
        if (reasoningEffort) {
          body.thinking = { type: "adaptive", display: "summarized" };
          body.output_config = { effort: reasoningEffort };
        }
        // No temperature/top_p/top_k — 4.7 rejects non-default values
      } else {
        // Opus 4.6 and below: budget-based thinking + temperature
        if (reasoningEffort) {
          const effective = downgradeEffort(reasoningEffort, ["low", "medium", "high"]);
          const budget = effective === "high" ? 32768 : effective === "medium" ? 16384 : 8192;
          body.thinking = { type: "enabled", budget_tokens: budget };
          // Fail-safe: max_tokens must be > budget_tokens or Anthropic rejects (HTTP 400).
          // Caller is expected to size max_tokens to fit; this guards against forgetting.
          if ((body.max_tokens as number) <= budget) {
            body.max_tokens = budget + 4096;
          }
          body.temperature = 1; // required when thinking is enabled
        } else {
          body.temperature = temperature;
        }
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throwHttpApiError(res, text, "anthropic", model);
      }
      const response = res;

      let currentBlock:
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string; signature?: string }
        | { type: "redacted_thinking"; data: string }
        | { type: "tool_use"; id?: string; name?: string; arguments: string }
        | null = null;
      const assistantBlocks: AnthropicAssistantBlock[] = [];
      let outputTokens = 0;
      // Raw API usage object — merged from message_start (input/cache/service_tier) +
      // message_delta (output_tokens). Stored as-is, no field enumeration.
      let rawUsage: Record<string, unknown> | undefined;

      for await (const { event, data } of parseSSE(response)) {
        if (signal.aborted) break;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType = event ?? parsed.type;

        switch (eventType) {
          case "message_start": {
            if (parsed.message?.usage && typeof parsed.message.usage === "object") {
              rawUsage = { ...(parsed.message.usage as Record<string, unknown>) };
            }
            break;
          }

          case "content_block_start": {
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              currentBlock = {
                type: "tool_use",
                id: block.id,
                name: block.name,
                arguments: "",
              };
            } else if (block?.type === "thinking") {
              currentBlock = {
                type: "thinking",
                thinking: typeof block.thinking === "string" ? block.thinking : "",
                signature: typeof block.signature === "string" ? block.signature : undefined,
              };
            } else if (block?.type === "redacted_thinking") {
              currentBlock = {
                type: "redacted_thinking",
                data: typeof block.data === "string" ? block.data : "",
              };
            } else {
              currentBlock = {
                type: "text",
                text: typeof block?.text === "string" ? block.text : "",
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) {
              if (currentBlock?.type === "text") {
                currentBlock.text += delta.text;
                yield { type: "text", text: delta.text };
              }
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              if (currentBlock?.type === "thinking") currentBlock.thinking += delta.thinking;
              yield { type: "thinking", text: delta.thinking };
            } else if (delta?.type === "signature_delta" && currentBlock?.type === "thinking") {
              currentBlock.signature = delta.signature;
            } else if (
              delta?.type === "input_json_delta" &&
              delta.partial_json &&
              currentBlock
            ) {
              if (currentBlock.type === "tool_use") {
                currentBlock.arguments += delta.partial_json;
                yield {
                  type: "tool_call_delta",
                  id: currentBlock.id ?? "",
                  name: currentBlock.name ?? "",
                  arguments_delta: delta.partial_json,
                };
              }
            }
            break;
          }

          case "content_block_stop":
            if (currentBlock?.type === "tool_use") {
              let parsedArguments: Record<string, unknown> = {};
              try {
                parsedArguments = currentBlock.arguments ? JSON.parse(currentBlock.arguments) : {};
              } catch {}
              assistantBlocks.push({
                type: "tool_use",
                id: currentBlock.id ?? "_tool",
                name: currentBlock.name ?? "unknown_tool",
                input: parsedArguments,
              });
              yield {
                type: "tool_call",
                id: currentBlock.id ?? "_tool",
                name: currentBlock.name ?? "unknown_tool",
                arguments: currentBlock.arguments,
              };
            } else if (currentBlock?.type === "thinking") {
              assistantBlocks.push({
                type: "thinking",
                thinking: currentBlock.thinking,
                ...(currentBlock.signature ? { signature: currentBlock.signature } : {}),
              });
            } else if (currentBlock?.type === "redacted_thinking") {
              assistantBlocks.push(currentBlock);
            } else if (currentBlock?.type === "text" && currentBlock.text) {
              assistantBlocks.push(currentBlock);
            }
            currentBlock = null;
            break;

          case "message_delta":
            // message_delta carries incremental usage updates (notably output_tokens during thinking).
            if (parsed.usage && typeof parsed.usage === "object") {
              rawUsage = { ...(rawUsage ?? {}), ...(parsed.usage as Record<string, unknown>) };
              if (typeof parsed.usage.output_tokens === "number") {
                outputTokens = parsed.usage.output_tokens;
              }
            }
            break;

          case "message_stop": {
            if (assistantBlocks.length > 0 || rawUsage) {
              const anthropicData: AnthropicSidecar = {
                contentBlocks: assistantBlocks,
                ...(rawUsage ? { usage_raw: rawUsage } : {}),
              };
              yield {
                type: "provider_sidecar",
                providerSidecarData: { anthropic: anthropicData },
              };
            }
            // Outer aggregate: input includes cache_read + cache_create (framework convention).
            const nakedInput = typeof rawUsage?.input_tokens === "number" ? rawUsage.input_tokens : 0;
            const cacheRead = typeof rawUsage?.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0;
            const cacheCreate = typeof rawUsage?.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0;
            yield { type: "usage", inputTokens: nakedInput + cacheRead + cacheCreate, outputTokens };
            break;
          }
        }
      }
    },
  };
}

registerProvider("anthropic-messages", createAnthropicProvider);

export { createAnthropicProvider, contentToAnthropic, messagesToAnthropic };
