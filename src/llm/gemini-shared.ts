/** Shared utilities for Gemini 2.x and 3.x adapters */

import { createPartFromUri, GoogleGenAI } from "@google/genai";
import type { ContentPart } from "../core/types.js";
import { isFileMediaContentPart, isInlineMediaContentPart } from "../core/types.js";
import type { LLMMessage } from "./types.js";
import { readMediaBytes, readFileBytes } from "./media-storage.js";
import { listSupported } from "./types.js";
import type { ToolDefinition } from "../core/types.js";

const GEMINI_INLINE_FILE_API_THRESHOLD_BYTES = 20 * 1024 * 1024;

const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/heif",
  "image/heic",
  "image/webp",
  "image/jpeg",
  "image/png",
]);
const GEMINI_SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/flac",
  "audio/ogg",
  "audio/aac",
  "audio/aiff",
  "audio/mp3",
  "audio/wav",
]);
const GEMINI_SUPPORTED_VIDEO_MIME_TYPES = new Set([
  "video/3gpp",
  "video/wmv",
  "video/webm",
  "video/mpg",
  "video/x-flv",
  "video/avi",
  "video/mov",
  "video/mpeg",
  "video/mp4",
]);

const GEMINI_SUPPORTED_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);

export function describeGeminiError(err: unknown): Record<string, unknown> {
  const read = (value: unknown, depth = 0): Record<string, unknown> | null => {
    if (typeof value !== "object" || value === null || depth > 2) return null;
    const entry = value as Record<string, unknown>;
    return {
      name: typeof entry.name === "string" ? entry.name : undefined,
      message: typeof entry.message === "string" ? entry.message : undefined,
      status: typeof entry.status === "number" ? entry.status : undefined,
      code: typeof entry.code === "string" ? entry.code : undefined,
      stack: typeof entry.stack === "string"
        ? entry.stack.split("\n").slice(0, 3).join("\n")
        : undefined,
      details: Array.isArray(entry.details) ? entry.details : undefined,
      cause: read(entry.cause, depth + 1) ?? undefined,
    };
  };
  return read(err) ?? { value: String(err) };
}

interface GoogleFileRef {
  index: number;
  uri: string;
  mimeType: string;
  name?: string;
}

interface GoogleMessageSidecarRecord {
  fileRefs?: GoogleFileRef[];
  /** Raw Gemini API usageMetadata object — full passthrough, not enumerated. New API
   *  fields automatically captured. Schema: `promptTokenCount`, `candidatesTokenCount`,
   *  `thoughtsTokenCount`, `cachedContentTokenCount`, `toolUsePromptTokenCount`,
   *  `totalTokenCount`, `promptTokensDetails[]`, `candidatesTokensDetails[]` (per-modality
   *  TEXT/IMAGE/AUDIO/VIDEO breakdowns).
   *  Named `usage_raw` (not `usage`) to avoid collision with the framework-level
   *  outer `usage: { inputTokens, outputTokens }` standardized aggregate. */
  usage_raw?: Record<string, unknown>;
}

function readGoogleMessageSidecarRecord(msg: LLMMessage): GoogleMessageSidecarRecord | null {
  const raw = msg.providerSidecarData?.google;
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const fileRefs = Array.isArray(entry.fileRefs)
    ? entry.fileRefs.flatMap((item): GoogleFileRef[] => {
        if (!item || typeof item !== "object") return [];
        const ref = item as Record<string, unknown>;
        return typeof ref.index === "number"
          && typeof ref.uri === "string"
          && typeof ref.mimeType === "string"
          ? [{
              index: ref.index,
              uri: ref.uri,
              mimeType: ref.mimeType,
              name: typeof ref.name === "string" ? ref.name : undefined,
            }]
          : [];
      })
    : undefined;
  return fileRefs?.length ? { fileRefs } : null;
}

function mergeGoogleSidecarData(
  msg: LLMMessage,
  patch: Record<string, unknown>,
): LLMMessage {
  const current = msg.providerSidecarData;
  const googleCurrent =
    current?.google && typeof current.google === "object"
      ? current.google as Record<string, unknown>
      : {};
  return {
    ...msg,
    providerSidecarData: {
      ...(current ?? {}),
      google: {
        ...googleCurrent,
        ...patch,
      },
    },
  };
}

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiSchema(item));
  }
  if (schema == null || typeof schema !== "object") {
    return schema;
  }

  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = sanitizeGeminiSchema(value);
  }

  const enumValues = input.enum;
  if (Array.isArray(enumValues) && enumValues.some((value) => typeof value !== "string")) {
    delete output.enum;

    const allowedValues = enumValues.map((value) => JSON.stringify(value)).join(", ");
    const note = `Allowed values: ${allowedValues}.`;
    const description =
      typeof output.description === "string" ? output.description.trim() : "";
    output.description = description ? `${description} ${note}` : note;
  }

  return output;
}

export function toolDefsToGemini(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Google function schemas reject some JSON Schema variants such as numeric enum values.
        parameters: sanitizeGeminiSchema({
          type: "object",
          properties: t.input_schema.properties,
          required: t.input_schema.required,
        }),
      })),
    },
  ];
}

export async function contentPartsToGemini(content: ContentPart[], message?: LLMMessage): Promise<any[]> {
  const fileRefsByIndex = new Map(
    (message ? readGoogleMessageSidecarRecord(message)?.fileRefs : undefined)?.map((ref) => [ref.index, ref]) ?? [],
  );
  const parts: any[] = [];
  for (let index = 0; index < content.length; index++) {
    const p = content[index];
    if (p.type === "text") { parts.push({ text: p.text }); continue; }

    const uploadedRef = fileRefsByIndex.get(index);
    if (uploadedRef) {
      parts.push(createPartFromUri(uploadedRef.uri, uploadedRef.mimeType));
      continue;
    }

    if (p.type === "text_file") {
      try {
        const { bytes, mimeType } = await readFileBytes(p);
        parts.push({ text: `[file: ${p.path}]` });
        parts.push({ inlineData: { data: bytes.toString("base64"), mimeType: mimeType ?? "text/plain" } });
      } catch {
        parts.push({ text: `[file unavailable: ${p.path}]` });
      }
      continue;
    }

    if (p.type === "file") {
      // Read first so the supported-mime gate sees the sniff-corrected mime.
      let bytes: Buffer;
      let mimeType: string;
      try {
        ({ bytes, mimeType } = await readFileBytes(p));
      } catch {
        parts.push({ text: `[file unavailable: ${p.path}]` });
        continue;
      }
      if (!GEMINI_SUPPORTED_FILE_MIME_TYPES.has(mimeType)) {
        parts.push({ text: `[file unsupported by Gemini: ${p.path} (${mimeType})]` });
        continue;
      }
      parts.push({ inlineData: { data: bytes.toString("base64"), mimeType } });
      continue;
    }

    if (isFileMediaContentPart(p)) {
      try {
        const { bytes, mimeType } = await readMediaBytes(p);
        parts.push({ text: `[file: ${p.path}]` });
        parts.push({ inlineData: { data: bytes.toString("base64"), mimeType } });
      } catch {
        const mediaType = p.type.replace("_file", "");
        parts.push({ text: `[${mediaType} unavailable: ${p.path}]` });
      }
      continue;
    }

    if (!isInlineMediaContentPart(p)) {
      parts.push({ text: `[unknown content type]` });
      continue;
    }

    // Sniff inline bytes via readMediaBytes so dirty mime (e.g. JPEG bytes
    // declared image/png) gets corrected — same hygiene path as file media.
    const { bytes, mimeType: sniffedMime } = await readMediaBytes(p);
    const supportedMimes =
      p.type === "image" ? GEMINI_SUPPORTED_IMAGE_MIME_TYPES
        : p.type === "audio" ? GEMINI_SUPPORTED_AUDIO_MIME_TYPES
          : p.type === "video" ? GEMINI_SUPPORTED_VIDEO_MIME_TYPES
            : null;
    if (supportedMimes && !supportedMimes.has(sniffedMime)) {
      parts.push({
        text:
          `[${p.type}: unsupported by Gemini API for mime ${sniffedMime}. ` +
          `Supported ${p.type} MIME types: ${listSupported(supportedMimes)}]`,
      });
      continue;
    }
    parts.push({ inlineData: { data: bytes.toString("base64"), mimeType: sniffedMime } });
  }
  return parts;
}

export async function prepareGeminiInboundMessages(
  client: GoogleGenAI,
  messages: LLMMessage[],
  signal: AbortSignal,
): Promise<LLMMessage[]> {
  return await Promise.all(messages.map(async (msg) => await prepareGeminiInboundMessage(client, msg, signal)));
}

async function prepareGeminiInboundMessage(
  client: GoogleGenAI,
  msg: LLMMessage,
  signal: AbortSignal,
): Promise<LLMMessage> {
  if (msg.role !== "user") {
    return msg;
  }

  const existingRefs = readGoogleMessageSidecarRecord(msg)?.fileRefs ?? [];
  const existingIndexes = new Set(existingRefs.map((ref) => ref.index));
  const uploadedRefs: GoogleFileRef[] = [...existingRefs];

  for (const [index, part] of msg.content.entries()) {
    if (signal.aborted || existingIndexes.has(index)) continue;
    const uploadTarget = await resolveGeminiUploadTarget(part);
    if (!uploadTarget) continue;
    const uploaded = await client.files.upload({
      file: uploadTarget.file,
      config: { mimeType: uploadTarget.mimeType },
    });
    if (!uploaded.uri) {
      throw new Error("Gemini files.upload returned no uri");
    }
    uploadedRefs.push({
      index,
      uri: uploaded.uri,
      mimeType: uploaded.mimeType ?? uploadTarget.mimeType,
      name: uploaded.name,
    });
  }

  return uploadedRefs.length > 0
    ? mergeGoogleSidecarData(msg, { fileRefs: uploadedRefs })
    : msg;
}

async function resolveGeminiUploadTarget(
  part: ContentPart,
): Promise<{ file: Blob; mimeType: string } | null> {
  // All branches route through the single dispatch points readMediaBytes /
  // readFileBytes — inContainer-aware reads + magic-byte mime sniff. Returns
  // a Blob (rather than a path) so File API upload always receives the
  // sniff-corrected mime and container-aware bytes; using `part.path` directly
  // would bypass sandboxFs bridge for container-only paths.
  let bytes: Buffer;
  let mimeType: string;
  try {
    if (isFileMediaContentPart(part)) {
      ({ bytes, mimeType } = await readMediaBytes(part));
    } else if (part.type === "text_file" || part.type === "file") {
      ({ bytes, mimeType } = await readFileBytes(part));
    } else if (isInlineMediaContentPart(part)) {
      ({ bytes, mimeType } = await readMediaBytes(part));
    } else {
      return null;
    }
  } catch {
    return null;
  }
  // generic `file` gate on sniffed mime (not declared)
  if (part.type === "file" && !GEMINI_SUPPORTED_FILE_MIME_TYPES.has(mimeType)) return null;
  if (bytes.byteLength <= GEMINI_INLINE_FILE_API_THRESHOLD_BYTES) return null;
  return {
    // Wrap as Uint8Array view so Blob accepts it as BlobPart (Buffer's
    // ArrayBufferLike doesn't narrow to ArrayBuffer in strict TS).
    file: new globalThis.Blob([new Uint8Array(bytes)], { type: mimeType }),
    mimeType,
  };
}

function toolResultText(msg: LLMMessage): string {
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
    .join("");
}

interface ToolResponseCollectOptions {
  textFallback?: boolean;
}

/** Convert a terminal tool result message into a Gemini functionResponse part. */
export function toolResultPartToGemini(msg: LLMMessage): any {
  return {
    functionResponse: {
      name: msg.toolName ?? "unknown_tool",
      response: { result: toolResultText(msg) },
    },
  };
}

/** Group contiguous terminal tool results into one Gemini user turn. */
export function collectToolResponsesToGemini(
  messages: LLMMessage[],
  startIndex: number,
  options: ToolResponseCollectOptions = {},
): {
  content: any;
  nextIndex: number;
} {
  const textFallback = options.textFallback ?? false;
  const parts: any[] = [];
  let index = startIndex;

  while (index < messages.length && messages[index].role === "tool") {
    const msg = messages[index];
    if (msg.toolStatus !== "pending") {
      if (textFallback) {
        const toolName = msg.toolName ?? "unknown_tool";
        const resultText = toolResultText(msg);
        parts.push({
          text: `(Result of ${toolName}: ${(resultText || "(empty)").slice(0, 300)})`,
        });
      } else {
        parts.push(toolResultPartToGemini(msg));
      }
    }
    index++;
  }

  const contentParts =
    parts.length > 0
      ? parts
      : [{ text: "[tool results unavailable]" }];

  return {
    content: {
      role: "user",
      parts: contentParts,
    },
    nextIndex: index,
  };
}

/** Shared usageMetadata → StreamEvent yield logic for Gemini 2.x and 3.x. */
export function* yieldGeminiUsage(chunk: any): Generator<import("./types.js").StreamEvent> {
  const meta = chunk.usageMetadata as Record<string, unknown> | undefined;
  if (!meta) return;
  const sidecarData: GoogleMessageSidecarRecord = { usage_raw: meta };
  yield {
    type: "provider_sidecar",
    providerSidecarData: { google: sidecarData },
  };
  // Outer aggregate: input = promptTokenCount; output = candidates + thoughts (Gemini
  // separates thinking tokens from candidatesTokenCount).
  const promptTokenCount = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
  const candidatesTokenCount = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
  const thinkingTokens = typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0;
  yield {
    type: "usage",
    inputTokens: promptTokenCount,
    outputTokens: candidatesTokenCount + thinkingTokens,
  };
}

/** Stream response parts and yield StreamEvents. Shared streaming logic. */
export async function* streamGeminiResponse(
  response: AsyncIterable<any>,
  signal: AbortSignal,
): AsyncGenerator<import("./types.js").StreamEvent> {
  let hasContent = false;
  let lastFinishReason: string | undefined;

  for await (const chunk of response) {
    if (signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      lastFinishReason = candidate.finishReason as string;
    }

    const parts = candidate?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.functionCall) {
          hasContent = true;
          const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          yield {
            type: "tool_call",
            id,
            name: part.functionCall.name!,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          };
        } else if (part.text != null) {
          hasContent = true;
          if ((part as any).thought) {
            yield { type: "thinking", text: part.text };
          } else {
            yield { type: "text", text: part.text };
          }
        }
      }
    }

    if (chunk.usageMetadata) {
      yield* yieldGeminiUsage(chunk);
    }
  }

  if (!hasContent && !signal.aborted && lastFinishReason && lastFinishReason !== "STOP" && lastFinishReason !== "MAX_TOKENS") {
    yield { type: "text", text: `[Gemini blocked: finishReason=${lastFinishReason}]` };
  }
}
