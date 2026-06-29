/** Tool normalizer —— pending / result 构造 + 历史 timeline 修复（normalizeHistory）。
 *
 *  与 agenteam ref 1:1：provider 层用 createPending / createToolResult；
 *  context-window replay 走 normalizeHistory（drop raw tool dups + 把死掉的 pending
 *  转 interrupted）；ConsciousAgent 在重启恢复路径上调 buildPersistentToolRepair
 *  把 interrupted 转成 synthetic 落盘。 */

import type { ContentPart } from "../core/types.js";
import { contentToString, normalizeContent } from "../message/modality.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";

export interface NormalizedToolTimeline {
  messages: LLMMessage[];
  changed: boolean;
  hasInterruptedToolCalls: boolean;
}

export interface PersistentToolRepair {
  messages: LLMMessage[];
  changed: boolean;
  needsRepair: boolean;
}

export function isTerminalToolMessage(msg: LLMMessage): boolean {
  return msg.role === "tool" && msg.toolStatus !== "pending";
}

export function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export function createPendingToolMessage(toolCall: LLMToolCall): LLMMessage {
  return {
    role: "tool",
    content: normalizeContent(`[Pending: ${toolCall.name}]`),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "pending",
    ts: Date.now(),
  };
}

export function createPendingToolMessages(toolCalls: LLMToolCall[]): LLMMessage[] {
  return toolCalls.map(createPendingToolMessage);
}

const INLINE_MEDIA_TYPES = new Set(["image", "video", "audio"]);

function inferRequiredFields(type: string): string[] | null {
  if (type === "text") return ["text"];
  if (INLINE_MEDIA_TYPES.has(type)) return ["data", "mimeType"];
  if (type === "file" || type === "text_file" || type.endsWith("_file")) return ["path", "mimeType"];
  return null;
}

function isContentPartArray(v: unknown): v is ContentPart[] {
  return Array.isArray(v) && v.length > 0 && typeof (v as any[])[0]?.type === "string";
}

function validateContentParts(parts: ContentPart[]): { parts: ContentPart[]; errors: string[] } {
  const valid: ContentPart[] = [];
  const errors: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as Record<string, unknown>;
    const t = p.type as string;
    const required = inferRequiredFields(t);
    if (!required) {
      valid.push(parts[i]);
      continue;
    }
    const missing = required.filter((f) => typeof p[f] !== "string");
    if (missing.length > 0) {
      const actualShape = Object.keys(p).map((k) => `${k}: ${typeof p[k]}`).join(", ");
      errors.push(
        `parts[${i}]: type="${t}" requires top-level string fields [${required.join(", ")}], ` +
        `but missing: [${missing.join(", ")}]. Actual shape: { ${actualShape} }`,
      );
      continue;
    }
    valid.push(parts[i]);
  }
  return { parts: valid, errors };
}

export function createToolResultMessage(toolCall: LLMToolCall, result: unknown): LLMMessage {
  let content: string | ContentPart[];
  if (isContentPartArray(result)) {
    const { parts, errors } = validateContentParts(result);
    if (errors.length > 0) {
      const errorReport = errors.join("\n");
      content = parts.length > 0
        ? [...parts, { type: "text" as const, text: `\n[ContentPart format error — some parts were dropped]\n${errorReport}` }]
        : `[ContentPart format error — all parts invalid]\n${errorReport}\n\n` +
          `Tool result must use the internal ContentPart format, NOT any LLM provider's API format.\n` +
          `Inline media: { type: "image"|"video"|"audio", data: "<base64>", mimeType: "<mime>" }\n` +
          `File-based:   { type: "image_file"|"video_file"|"audio_file", path: "<path>", mimeType: "<mime>" }\n` +
          `Text:         { type: "text", text: "<content>" }`;
    } else {
      content = parts;
    }
  } else if (typeof result === "string") {
    content = result;
  } else {
    content = JSON.stringify(result);
  }
  return {
    role: "tool",
    content: normalizeContent(content),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: isToolErrorResult(result) ? "failed" : "completed",
    ts: Date.now(),
  };
}

export function createSyntheticToolResult(
  toolCall: LLMToolCall,
  reason = `[Error: tool call "${toolCall.name}" was interrupted — no result available]`,
): LLMMessage {
  return {
    role: "tool",
    content: normalizeContent(reason),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "synthetic",
  };
}

export function createInterruptedToolResult(
  toolCall: LLMToolCall,
  reason = `[Interrupted: tool call "${toolCall.name}" did not produce a result before the conversation moved on]`,
): LLMMessage {
  return {
    role: "tool",
    content: normalizeContent(reason),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "interrupted",
  };
}

/** Normalize tool call / tool result pairing in memory:
 *  - Drop raw tool ledger duplicates from replay
 *  - Route each tool call to its best visible state
 *  - Keep live in-flight calls as pending
 *  - Mark dead pending/missing calls as interrupted once conversation moved on */
export function normalizeToolTimeline(messages: LLMMessage[]): NormalizedToolTimeline {
  const result: LLMMessage[] = [];
  let hasInterruptedToolCalls = false;
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      changed = true;
      continue;
    }

    result.push(msg);

    if (!msg.toolCalls?.length) continue;

    const bestById = new Map<string, LLMMessage>();
    let cursor = i + 1;

    while (cursor < messages.length && messages[cursor].role === "tool") {
      const toolMsg = messages[cursor];
      const callId = toolMsg.toolCallId;
      if (callId) {
        const normalized = {
          ...toolMsg,
          toolName: toolMsg.toolName ?? msg.toolCalls.find((tc) => tc.id === callId)?.name,
        };
        const current = bestById.get(callId);
        if (!current || compareToolMessagePriority(normalized, current) > 0) {
          bestById.set(callId, normalized);
        }
      }
      cursor++;
    }

    const batchClosed = cursor < messages.length;
    for (const tc of msg.toolCalls) {
      const toolMsg = bestById.get(tc.id);
      if (toolMsg) {
        if (toolMsg.toolStatus === "pending" && batchClosed) {
          result.push(createInterruptedToolResult(tc));
          hasInterruptedToolCalls = true;
          changed = true;
        } else {
          result.push(toolMsg);
        }
      } else {
        if (batchClosed) {
          result.push(createInterruptedToolResult(tc));
          hasInterruptedToolCalls = true;
          changed = true;
        } else {
          result.push(createPendingToolMessage(tc));
          changed = true;
        }
      }
    }

    i = cursor - 1;
  }

  return { messages: result, changed, hasInterruptedToolCalls };
}

export function buildPersistentToolRepair(messages: LLMMessage[]): PersistentToolRepair {
  const normalized = normalizeToolTimeline(messages);
  let repairChanged = false;
  const repairedMessages = normalized.messages.map((msg) => {
    if (msg.role === "tool" && msg.toolStatus === "interrupted") {
      repairChanged = true;
      return {
        ...msg,
        content: normalizeContent(contentToString(msg.content).replace("[Interrupted:", "[Error:")),
        toolStatus: "synthetic" as const,
      };
    }
    return msg;
  });

  return {
    messages: repairedMessages,
    changed: normalized.changed || repairChanged,
    needsRepair: normalized.hasInterruptedToolCalls,
  };
}

function compareToolMessagePriority(a: LLMMessage, b: LLMMessage): number {
  return toolMessagePriority(a) - toolMessagePriority(b);
}

function toolMessagePriority(msg: LLMMessage): number {
  if (msg.role !== "tool") return -1;
  if (msg.toolStatus === "completed" || msg.toolStatus === "failed") return 3;
  if (msg.toolStatus === "synthetic") return 2;
  if (msg.toolStatus === "pending") return 1;
  if (isTerminalToolMessage(msg)) return 3;
  return 0;
}

/** History normalization entrypoint —— chains all normalizers。
 *  目前只跑 timeline 修复；后续 media dedup / message merge 等加进来不影响 caller。 */
export function normalizeHistory(messages: LLMMessage[]): NormalizedToolTimeline {
  return normalizeToolTimeline(messages);
}
