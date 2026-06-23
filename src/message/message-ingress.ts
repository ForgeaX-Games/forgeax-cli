/** message-ingress —— EventBus 上的原始 event → ContextWindow 能消费的 LLMMessage。
 *
 *  与 agenteam ref 1:1（plan §3.8）：
 *  - 入口 `eventToSessionMessage(event): LLMMessage | null`
 *  - 有 ContentPayload（event.payload.content）→ 升格成 user message；非 user_input
 *    类型加 `[source:type]` 前缀，方便模型分辨来源。
 *  - 无 ContentPayload 但 payload 含 visual_display / warning / error → fallback
 *    成 JSON 字符串塞回 user message（防止丢信息）。
 *  - sanitizeParts：把 user / cross-agent inbound 内容里的 `<system-*>` /
 *    `<*-principle>` 标签降级成 `<user-*>`，避免 LLM 误把它们当系统指令。 */

import type { ContentPart, Event } from "../core/types";
import { isContentPayload } from "../core/types";
import { normalizeContent } from "./modality";
import { sanitizeParts } from "./directive-sanitizer";
import type { LLMMessage } from "../llm/types";

function isContentPartArray(value: unknown): value is ContentPart[] {
  return Array.isArray(value)
    && value.every((part) => part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string");
}

function extractEventContentPayload(payload: unknown) {
  if (isContentPayload(payload)) {
    if (typeof payload.content === "string" || isContentPartArray(payload.content)) {
      return payload;
    }
    return null;
  }
  return null;
}

function buildEventPrefix(event: Event): string | null {
  if (event.type === "user_input") return null;
  if (event.type === "message") return `Message from ${event.source}`;
  return `[${event.source}:${event.type}]`;
}

export function eventToSessionMessage(event: Event): LLMMessage | null {
  const payload = extractEventContentPayload(event.payload);
  if (payload) {
    const prefix = buildEventPrefix(event);
    const parts = sanitizeParts(normalizeContent(payload.content));
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
