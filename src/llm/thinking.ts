import type { ContentPart } from "../core/types.js";
import type { LLMMessage } from "./types.js";

const THINKING_BLOCK_RE = /<thinking>[\s\S]*?<\/thinking>\n?/g;

export function stripThinkingBlocks(text: string): string {
  return text.replace(THINKING_BLOCK_RE, "").trim();
}

export function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

export function isThinkingOnlyAssistantMessage(msg: LLMMessage): boolean {
  if (msg.role !== "assistant") return false;
  return Boolean(msg.thinking?.trim()) && !extractTextContent(msg.content) && !msg.toolCalls?.length;
}

export function extractMessageBodyText(msg: LLMMessage): string {
  const text = extractTextContent(msg.content);
  return msg.role === "assistant" ? stripThinkingBlocks(text) : text;
}
