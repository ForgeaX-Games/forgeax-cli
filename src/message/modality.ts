import type { ContentPart, InputModality } from "../core/types.js";
import { isFileMediaContentPart } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import { sanitizeInvalidSurrogates } from "../unicode/sanitize.js";

/** Ensure content is always ContentPart[]. */
export function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    const safe = sanitizeInvalidSurrogates(content);
    return safe.length > 0 ? [{ type: "text", text: safe }] : [];
  }
  return content
    .map((part) => (part.type === "text" ? { ...part, text: sanitizeInvalidSurrogates(part.text) } : part))
    .filter((part) => part.type !== "text" || part.text.length > 0);
}

/** Extract text-only string from string | ContentPart[]. */
export function contentToString(content: string | ContentPart[]): string {
  if (typeof content === "string") return sanitizeInvalidSurrogates(content);
  return sanitizeInvalidSurrogates(content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(""));
}

/**
 * Filter/degrade content parts based on model's supported input modalities.
 * Unsupported modalities are converted to text placeholders instead of being silently dropped.
 */
export function modalityFilter(
  parts: ContentPart[],
  supported: InputModality[],
): ContentPart[] {
  return parts.map((p) => {
    if (p.type === "file") return p;
    if ((p.type === "text" || p.type === "text_file") && !supported.includes("text")) {
      return { type: "text" as const, text: "[Text: 模型不支持文本输入]" };
    }
    if (p.type === "text" || p.type === "text_file") return p;
    if ((p.type === "image" || p.type === "image_file") && !supported.includes("image")) {
      return { type: "text" as const, text: "[Image: 模型不支持图片输入]" };
    }
    if ((p.type === "video" || p.type === "video_file") && !supported.includes("video")) {
      return { type: "text" as const, text: "[Video: 模型不支持视频输入]" };
    }
    if ((p.type === "audio" || p.type === "audio_file") && !supported.includes("audio")) {
      return { type: "text" as const, text: "[Audio: 模型不支持音频输入]" };
    }
    if (isFileMediaContentPart(p)) return p;
    return p;
  });
}

export function prepareMessagesForModel(
  messages: LLMMessage[],
  supported: InputModality[],
): LLMMessage[] {
  return messages.map((msg) => ({
    ...msg,
    content: modalityFilter(normalizeContent(msg.content), supported),
  }));
}
