import type { ContentPart, ToolDefinition, ToolOutput } from "#src/core/types.js";
import { lookup } from "mime-types";
import { basename } from "node:path";
import type { AgentFsAPI } from "#src/sandbox/fs-bridge.js";

type MediaType = "file" | "image" | "audio" | "video";

const FALLBACK_MIME: Record<MediaType, string> = {
  file: "application/octet-stream",
  image: "image/png",
  audio: "audio/mpeg",
  video: "video/mp4",
};

function isLocalPath(input: string): boolean {
  return input.startsWith("/") || input.startsWith("file://");
}

function toFsPath(input: string): string {
  return input.startsWith("file://") ? new URL(input).pathname : input;
}

function bufferToContentPart(buf: Buffer, mimeType: string, type: MediaType, name?: string): ContentPart {
  const data = buf.toString("base64");
  const mediaKind: "image" | "audio" | "video" | null =
    type === "file"
      ? mimeType.startsWith("image/") ? "image"
        : mimeType.startsWith("audio/") ? "audio"
        : mimeType.startsWith("video/") ? "video"
        : null
      : type === "image" || type === "audio" || type === "video"
        ? type
        : null;

  if (mediaKind) {
    // name is carried through externalization (EventLedger) → renderer display
    return { type: mediaKind, data, mimeType, ...(name ? { name } : {}) } as ContentPart;
  }
  return { type: "file" as any, data, mimeType } as ContentPart;
}

async function loadMedia(source: string, type: MediaType, fs: AgentFsAPI): Promise<ContentPart> {
  if (isLocalPath(source)) {
    const fsPath = toFsPath(source);
    const name = basename(fsPath);
    const mimeType = lookup(fsPath) || FALLBACK_MIME[type];
    const buf = await fs.readBinary(fsPath);
    return bufferToContentPart(buf, mimeType, type, name);
  }

  const res = await fetch(source);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? FALLBACK_MIME[type];
  // Extract filename from URL path, fallback to undefined
  const name = extractUrlFilename(source);
  const buf = Buffer.from(await res.arrayBuffer());
  return bufferToContentPart(buf, mimeType, type, name);
}

function extractUrlFilename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split("/").pop();
    return segment && segment.includes(".") ? decodeURIComponent(segment) : undefined;
  } catch { return undefined; }
}

export default {
  name: "send_media",
  description:
    "Send files (document, image, audio, video) directly to the **user** — NOT for inter-agent communication. " +
    "Supports http/https URLs and local file paths. " +
    "Text content is already delivered via your assistant message; use this tool only when you need to attach files to the user.",
  input_schema: {
    type: "object",
    properties: {
      attachments: {
        type: "array",
        description: "Media attachments — each item specifies a media type and source (URL or local path)",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["file", "image", "audio", "video"], description: "Attachment type: file (generic document/text), image, audio, or video" },
            source: { type: "string", description: "URL (http/https) or local file path (absolute path or file:// URI)" },
          },
          required: ["type", "source"],
        },
      },
    },
    required: ["attachments"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const attachments = (args.attachments ?? []) as Array<{ type: MediaType; source: string }>;
    if (!attachments.length) return '"attachments" must contain at least one item';

    const parts: ContentPart[] = [];
    for (const att of attachments) {
      try {
        parts.push(await loadMedia(att.source, att.type, ctx.fs));
      } catch (e: any) {
        return `Failed to load ${att.type} from ${att.source}: ${e.message}`;
      }
    }

    ctx.eventBus.publish({
      source: ctx.agentId,
      type: "media_attachment",
      payload: { content: parts },
      ts: Date.now(),
    });

    const summary = attachments.map(a => `[${a.type}] ${a.source}`).join(", ");
    return `Media sent to user: ${summary}`;
  },
  serial: false,
} satisfies ToolDefinition;
