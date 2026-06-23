// @desc Markdown event formatter for WeChat outbound — returns structured text + media parts
import stripAnsi from "strip-ansi";

export interface WeChatEvent {
  type: string;
  ts: number;
  source?: string;
  payload?: Record<string, unknown>;
}

export interface MediaAttachment {
  type: "image" | "audio" | "video" | "file";
  path?: string;
  data?: string;
  mimeType?: string;
}

export interface FormatResult {
  text: string | null;
  media: MediaAttachment[];
}

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter(p => p.type === "text" && p.text)
    .map(p => p.text as string)
    .join("");
}

function extractTextAndMedia(content: unknown): { text: string; media: MediaAttachment[] } {
  if (typeof content === "string") return { text: content, media: [] };
  if (!Array.isArray(content)) return { text: "", media: [] };

  const textParts: string[] = [];
  const media: MediaAttachment[] = [];

  for (const p of content as Array<Record<string, unknown>>) {
    if (p.type === "text" && p.text) {
      textParts.push(p.text as string);
    } else if ((p.type === "file" || p.type === "text_file") && p.path) {
      media.push({ type: "file", path: p.path as string, mimeType: p.mimeType as string });
    } else if (p.type === "image" && p.data) {
      media.push({ type: "image", data: p.data as string, mimeType: p.mimeType as string });
    } else if (p.type === "image_file" && p.path) {
      media.push({ type: "image", path: p.path as string, mimeType: p.mimeType as string });
    } else if (p.type === "audio" && p.data) {
      media.push({ type: "audio", data: p.data as string, mimeType: p.mimeType as string });
    } else if (p.type === "audio_file" && p.path) {
      media.push({ type: "audio", path: p.path as string, mimeType: p.mimeType as string });
    } else if (p.type === "video" && p.data) {
      media.push({ type: "video", data: p.data as string, mimeType: p.mimeType as string });
    } else if (p.type === "video_file" && p.path) {
      media.push({ type: "video", path: p.path as string, mimeType: p.mimeType as string });
    }
  }

  return { text: textParts.join(""), media };
}

/**
 * Format a Gateway event into a structured result with Markdown text and media attachments.
 * Returns null for events that should not be forwarded.
 */
export function formatEventForWeChat(event: WeChatEvent): FormatResult | null {
  const p = event.payload ?? {};

  const errorStr = p.error as string | undefined;
  if (errorStr) return { text: `**ERROR** ${errorStr}`, media: [] };
  const warnStr = p.warning as string | undefined;
  if (warnStr) return { text: `> ⚠️ ${warnStr}`, media: [] };

  switch (event.type) {
    case "hook:toolResult": {
      const tool = (p.name ?? "") as string;
      if (tool === "send_media") return null;
      const durationMs = (p.durationMs ?? 0) as number;
      const rawDisplay = p.visual_display as string | undefined;
      const display = rawDisplay ? stripAnsi(rawDisplay) : undefined;
      const text = display
        ? `\`← ${tool}\` (${durationMs}ms): ${display}`
        : `\`← ${tool}\` (${durationMs}ms)`;
      return { text, media: [] };
    }

    case "message": {
      const raw = (p.visual_display as string) ?? extractPlainText(p.content);
      const display = raw ? stripAnsi(raw) : "";
      if (!display) return null;
      return { text: `> 💬 **${event.source}**: ${display.slice(0, 500)}`, media: [] };
    }

    default: {
      const { text, media } = extractTextAndMedia(p.content);
      const raw = (p.visual_display as string) ?? (p.text as string) ?? text;
      const display = raw ? stripAnsi(raw) : "";
      if (!display && !media.length) return null;
      return { text: display ? `> **${event.source}**: ${display.slice(0, 500)}` : null, media };
    }
  }
}
