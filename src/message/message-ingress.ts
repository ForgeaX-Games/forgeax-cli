import type { ContentPart, ContentPayload, Event } from "../core/types.js";
import { isContentPayload } from "../core/types.js";
import { normalizeContent } from "./modality.js";
import { sanitizeParts } from "./directive-sanitizer.js";
import type { LLMMessage } from "../llm/types.js";

function isContentPartArray(value: unknown): value is ContentPart[] {
  return Array.isArray(value)
    && value.every((part) => part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string");
}

function extractEventContentPayload(payload: unknown): ContentPayload | null {
  if (isContentPayload(payload)) {
    if (typeof payload.content === "string" || isContentPartArray(payload.content)) {
      return payload;
    }
    return null;
  }
  return null;
}

function buildEventPrefix(event: Event): string | null {
  if (event.type === "user_input") {
    return null;
  }
  if (event.type === "message") {
    return `Message from ${event.source}`;
  }
  return `[${event.source}:${event.type}]`;
}

export function eventToSessionMessage(event: Event): LLMMessage | null {
  const payload = extractEventContentPayload(event.payload);
  if (payload) {
    const prefix = buildEventPrefix(event);
    const content = payload.content;
    const parts = sanitizeParts(normalizeContent(content));
    return {
      role: "user",
      content: prefix ? [{ type: "text", text: `${prefix}\n` }, ...parts] : parts,
      ts: event.ts || Date.now(),
    };
  }

  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (!p.content && !p.visual_display && !p.warning && !p.error) return null;

  const fallback = (() => {
    try { return JSON.stringify(event.payload); }
    catch { return "[unserializable payload]"; }
  })();
  return {
    role: "user",
    content: sanitizeParts(normalizeContent(`[${event.source}:${event.type}] ${fallback}`)),
    ts: event.ts || Date.now(),
  };
}
