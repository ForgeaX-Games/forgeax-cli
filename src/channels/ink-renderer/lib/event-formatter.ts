/**
 * Event formatter — converts StoredEvent records into RendererMessage objects.
 * Uses a registry pattern instead of a monolithic switch-case.
 */

import type { StoredEvent, RendererMessage, ToolResultMessage } from "../types.js";
import type { LLMMessage } from "../../../llm/types.js";
import { extractMessageBodyText } from "../../../llm/thinking.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { resolveStateDir } from "../../../fs/state-dir.js";
import { registerSubagentFormatters } from "./subagent-events.js";

type Formatter = (event: StoredEvent) => RendererMessage | null;

const MEDIA_CACHE_DIR = join(resolveStateDir(), "cache", "renderer", "medias");
let mediaDirReady = false;

/**
 * Resolve a media ContentPart to a displayable path + label.
 * - *_file (post-externalization): use path directly, no caching needed
 * - inline base64 (legacy/compat): decode to cache dir
 * Returns { path, label } or null.
 */
function resolveMediaPart(part: Record<string, unknown>): { path: string; label: string } | null {
  // *_file reference — already on disk, use directly; name derived from basename
  const filePath = part.path as string | undefined;
  if (filePath && typeof filePath === "string") {
    return { path: filePath, label: basename(filePath) };
  }

  // Inline base64 (legacy sessions) — decode to cache
  const data = part.data as string | undefined;
  if (!data || typeof data !== "string") return null;
  const name = part.name as string | undefined;
  const mime = (part.mimeType ?? "application/octet-stream") as string;
  const ext = mime.split("/")[1]?.replace(/\+.*$/, "") ?? "bin";
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  // Cache filename uses content-hash to avoid cross-request collisions:
  // multiple requests can produce files with the same basename (e.g.
  // every sprite request creates a `pixel_4directions_attempt_1.png`).
  // Using basename as the cache key with `existsSync` short-circuit means
  // every later send shows the FIRST request's image — earlier media
  // permanently masks later media. Hash-based naming makes cache hit
  // semantics correct (same content = same file) and avoids the alias.
  // The user-facing label still shows the original basename.
  const cachedName = `${hash}.${ext}`;
  const cachePath = join(MEDIA_CACHE_DIR, cachedName);
  const label = name || cachedName;
  try {
    if (!existsSync(cachePath)) {
      if (!mediaDirReady) { mkdirSync(MEDIA_CACHE_DIR, { recursive: true }); mediaDirReady = true; }
      writeFileSync(cachePath, Buffer.from(data, "base64"));
    }
    return { path: cachePath, label };
  } catch { return null; }
}

const registry = new Map<string, Formatter>();

export function registerFormatter(type: string, fn: Formatter): void {
  registry.set(type, fn);
}

registerSubagentFormatters(registerFormatter);

function displayContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map(p => {
      if (p.type === "text" && p.text) return p.text as string;
      if (p.type === "file" || p.type === "text_file") return `[文件: ${p.path}]`;
      if (p.type === "image_file") return `[图片: ${p.path}]`;
      if (p.type === "image") return `[图片]`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractLLMMessage(p: Record<string, unknown>): LLMMessage | null {
  const raw = p.llmMessage;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw[0] as LLMMessage ?? null;
  return raw as LLMMessage;
}

function ts(event: StoredEvent): number {
  return (event.ts as number) ?? Date.now();
}

function systemMsg(
  event: StoredEvent,
  textOverride?: string,
  level?: "info" | "warning" | "error",
): RendererMessage | null {
  const p = event.payload ?? {};
  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const text = textOverride ?? vis ?? (p.summary as string) ?? (p.text as string) ?? displayContent(p.content) ?? "";
  if (!text) return null;
  return { kind: "system", source: event.source ?? "", text, visualDisplay: vis, level, agent: event.emitterId ?? "", timestamp: ts(event) };
}

// Direction: `to === viewerId` → incoming, else outgoing. Same event lives in
// both sender's and receiver's ledgers, so viewer is required to resolve.

type Direction = "incoming" | "outgoing";

function classifyDirection(event: StoredEvent, viewerId?: string): { dir: Direction; from?: string; to?: string } {
  const toRaw = (event as { to?: unknown }).to;
  const to = typeof toRaw === "string" && toRaw.length > 0 ? toRaw : undefined;
  const from = typeof event.emitterId === "string" ? event.emitterId : undefined;
  if (to && viewerId && to === viewerId) return { dir: "incoming", from, to };
  return { dir: "outgoing", from, to };
}

/** Generic fallback: extract the most likely "primary" arg value for a short summary. */
function fallbackArgsSummary(args: Record<string, unknown>): string {
  if (args.description && typeof args.description === "string") {
    const d = args.description;
    return d.length > 80 ? d.slice(0, 77) + "..." : d;
  }
  const primary = args.path ?? args.file_path ?? args.query ?? args.command ?? args.cmd
    ?? args.pattern ?? args.url ?? args.search_term ?? args.name;
  if (primary != null) {
    const s = String(primary);
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  }
  const s = JSON.stringify(args);
  if (s === "{}" || s === "null") return "";
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

// ── Formatters ──

registerFormatter("user_input", (event) => {
  const p = event.payload ?? {};
  const d = p.display as Record<string, unknown> | undefined;
  const text = (p.visual_display as string) ?? (d?.text as string) ?? displayContent(p.content);
  if (!text) return null;
  const handoff = (p.handoff ?? event.handoff) as string | undefined;
  return {
    kind: "user_input",
    text,
    isSteer: handoff === "steer",
    source: event.source ?? "user",
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
});

// agent_command is a local meta event (issuer-side dispatch record), intentionally
// no direction — not inter-agent traffic.
registerFormatter("agent_command", (event) => {
  const p = event.payload ?? {};
  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const toolName = (p.toolName ?? p.tool ?? "") as string;
  const agent = (p.agentId ?? p.agent ?? event.emitterId ?? "") as string;
  return systemMsg(event, vis ?? `/${toolName} → ${agent}`);
});

registerFormatter("hook:assistantMessage", (event) => {
  const p = event.payload ?? {};
  const msg = extractLLMMessage(p);
  if (!msg) return null;
  const text = extractMessageBodyText(msg).trim();
  const thinking = msg.thinking?.trim() ?? "";
  if (!text && !thinking) return null;
  return {
    kind: "assistant_complete",
    text,
    thinking,
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
});

registerFormatter("hook:toolCall", (event) => {
  const p = event.payload ?? {};
  const name = (p.name ?? "") as string;
  if (name === "subagent") return null;
  const args = p.args ?? {};
  const tc = p.toolCall as { id?: string } | undefined;
  const callId = (p.callId ?? p.toolCallId ?? tc?.id ?? p.id ?? `${name}-${ts(event)}`) as string;
  let visualDisplay: string | undefined;
  if (p.visual_display) {
    visualDisplay = String(p.visual_display);
  } else if (name === "send_media") {
    const atts = (args as Record<string, unknown>).attachments as Array<{ type?: string }> | undefined;
    if (atts?.length) {
      const types = atts.map(a => a.type ?? "file");
      visualDisplay = types.length === 1 ? types[0] : `${types.length} attachments`;
    }
  } else if (name === "subagent") {
    const a = args as Record<string, unknown>;
    const task = String(a.task ?? "");
    const type = String(a.type ?? "");
    const mode = String(a.mode ?? "foreground");
    visualDisplay = `${type}, ${mode}: ${task.slice(0, 80)}`;
  } else if (name === "shell") {
    const a = args as Record<string, unknown>;
    const desc = a.description ? String(a.description) : undefined;
    const cmd = String(a.command ?? "");
    const cmdShort = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    visualDisplay = desc ?? cmdShort;
  } else {
    visualDisplay = fallbackArgsSummary(args as Record<string, unknown>);
  }
  return {
    kind: "tool_call",
    id: callId,
    name,
    status: "running" as const,
    visualDisplay,
    args,
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
});

registerFormatter("hook:toolResult", (event) => {
  const p = event.payload ?? {};
  const name = (p.name ?? "") as string;
  const durationMs = (p.durationMs ?? 0) as number;
  const errorText = p.error ? String(p.error) : "";

  if (name === "send_media") {
    return {
      kind: "tool_result",
      callId: (p.callId ?? p.toolCallId ?? p.id ?? `${name}-${ts(event)}`) as string,
      name,
      durationMs,
      isError: !!errorText,
      agent: event.emitterId ?? "",
      timestamp: ts(event),
    } as ToolResultMessage;
  }
  if (name === "subagent") return null;

  let visualDisplay: string | undefined;
  let fullContent = "";

  if (p.visual_display) {
    visualDisplay = String(p.visual_display);
  }

  if (!visualDisplay && !fullContent) {
    if (errorText) {
      fullContent = errorText;
    } else {
      const msg = extractLLMMessage(p);
      let raw = msg ? displayContent(msg.content) : "";
      if (raw && raw.startsWith("{")) {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          let text = String(obj.result ?? obj.error ?? obj.question ?? "");
          if (text.startsWith("[{")) {
            try {
              const arr = JSON.parse(text) as Array<{ type: string; text?: string }>;
              text = arr.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n");
            } catch { /* use as-is */ }
          }
          if (text) raw = text;
        } catch { /* use raw as-is */ }
      }
      fullContent = raw;
    }
  }

  const truncatedContent = fullContent.length > 2000
    ? fullContent.slice(0, 2000) + "\n…"
    : fullContent;

  return {
    kind: "tool_result",
    callId: (p.callId ?? p.toolCallId ?? p.id ?? `${name}-${ts(event)}`) as string,
    name,
    visualDisplay,
    content: truncatedContent,
    fullContent: fullContent.length > 2000 ? fullContent : undefined,
    durationMs,
    isError: !!errorText,
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
});

// hook:* events are universally dropped by the fallback (line ~344). `stream:llm`
// doesn't share that prefix so it must be explicitly dropped here.
registerFormatter("stream:llm", () => null);
registerFormatter("media_attachment", (event) => {
  const p = event.payload ?? {};
  const content = p.content as Array<Record<string, unknown>> | undefined;
  if (!content?.length) return null;

  const resolved: Array<{ path: string; label: string }> = [];
  for (const part of content) {
    const r = resolveMediaPart(part);
    if (r) resolved.push(r);
  }
  if (!resolved.length) return null;

  const label = resolved.length === 1 ? "📎 " : `📎 ${resolved.length} files:\n`;
  const display = resolved.map(r => `${r.label} (${r.path})`).join("\n");
  return {
    kind: "system",
    source: event.source ?? "",
    text: label + display,
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
});
// inbound_message: routed snapshot already rendered by user_input / assistantMessage /
// other inbound formatters — the model has seen this exact content. Drop to avoid
// showing the user (and the model on next replay) the same message twice.
registerFormatter("inbound_message", () => null);

registerFormatter("tick", (event) => {
  const p = event.payload ?? {};
  const msg = extractLLMMessage(p);
  if (msg) return null;
  return systemMsg(event);
});

// ── Main entry ──

export function formatEvent(event: StoredEvent, viewerId?: string): RendererMessage | null {
  const p = event.payload ?? {};

  if (p.error && event.type !== "hook:toolResult") return systemMsg(event, p.visual_display ? String(p.visual_display) : String(p.error), "error");
  if (p.warning) return systemMsg(event, p.visual_display ? String(p.visual_display) : String(p.warning), "warning");

  const formatter = registry.get(event.type);
  if (formatter) return formatter(event);

  if (event.type.startsWith("hook:") || event.type.startsWith("_")) return null;

  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const text = vis ?? displayContent(p.content);
  if (!text) return null;

  // Fallback for unrecognized non-hook events: emit structured direction/from/to
  // so the UI can render an icon / color of its choice.
  const dir = classifyDirection(event, viewerId);
  const isSelfEmit = !!viewerId && event.emitterId === viewerId;
  const source = event.source ?? "";
  // Outgoing (self-emit): show only event type. Incoming: source(type).
  const tag = isSelfEmit
    ? event.type
    : (source ? `${source}(${event.type})` : event.type);
  return {
    kind: "system",
    source: tag,
    text,
    visualDisplay: vis,
    direction: dir.dir,
    from: dir.from,
    to: dir.to,
    agent: event.emitterId ?? "",
    timestamp: ts(event),
  };
}
