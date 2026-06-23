/**
 * media-preflight.ts — Normalize media ContentParts before LLM consumption.
 *
 * At LLM query time, small *_file refs (<=1MB) are auto-inlined so the
 * provider receives base64 data directly. Larger files stay as *_file
 * references for providers to handle (native file API, chunking, etc.).
 *
 * Note: inline media in events.jsonl is externalized at WAL write time
 * by EventLedger — this module no longer handles persistence.
 */

import { readFile, stat } from "node:fs/promises";
import { isFileMediaContentPart, type ContentPart } from "../core/types.js";
import type { LLMMessage } from "./types.js";

const INLINE_MAX_BYTES = 1_048_576;   // <=1MB → inline for LLM

export async function prepareMessagesForMediaPolicy(
  messages: LLMMessage[],
): Promise<LLMMessage[]> {
  const result: LLMMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content) || msg.content.length === 0) {
      result.push(msg);
      continue;
    }
    let changed = false;
    const content: ContentPart[] = [];
    for (const part of msg.content) {
      const normalized = await normalizePart(part);
      if (normalized !== part) changed = true;
      content.push(normalized);
    }
    result.push(changed ? { ...msg, content } : msg);
  }
  return result;
}

async function normalizePart(part: ContentPart): Promise<ContentPart> {
  // Small text_file → inline text
  if (part.type === "text_file") {
    try {
      const info = await stat(part.path);
      if (info.size > INLINE_MAX_BYTES) return part;
      const buf = await readFile(part.path);
      return { type: "text", text: `[file: ${part.path}]\n${buf.toString("utf8")}` };
    } catch {
      return part;
    }
  }

  // Small *_file media → inline base64 for LLM consumption
  if (isFileMediaContentPart(part)) {
    try {
      const info = await stat(part.path);
      if (info.size > INLINE_MAX_BYTES) return part;
      const buf = await readFile(part.path);
      const mediaType = part.type.replace("_file", "") as "image" | "audio" | "video";
      return { type: mediaType, data: buf.toString("base64"), mimeType: part.mimeType };
    } catch {
      return part;
    }
  }

  return part;
}
