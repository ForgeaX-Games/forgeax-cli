/** Content utility functions — binary detection, type guards, file-to-ContentPart conversion. */

import type { ContentPart, ContentPayload, MediaContentPart, InlineMediaContentPart, FileMediaContentPart } from "./types.js";

// ─── Content type guards ───

export function isMediaContentPart(part: ContentPart): part is MediaContentPart {
  return part.type === "image" || part.type === "video" || part.type === "audio"
    || part.type === "image_file" || part.type === "video_file" || part.type === "audio_file";
}

export function isInlineMediaContentPart(part: ContentPart): part is InlineMediaContentPart {
  return part.type === "image" || part.type === "video" || part.type === "audio";
}

export function isFileMediaContentPart(part: ContentPart): part is FileMediaContentPart {
  return part.type === "image_file" || part.type === "video_file" || part.type === "audio_file";
}

export function isContentPayload(payload: unknown): payload is ContentPayload {
  if (!payload || typeof payload !== "object") return false;
  return "content" in payload;
}

// ─── Binary detection ───

const BINARY_PROBE_SIZE = 8192;

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_PROBE_SIZE);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function isBinaryFile(path: string): Promise<boolean> {
  const fd = await import("node:fs/promises").then(m => m.open(path, "r"));
  try {
    const buf = Buffer.alloc(BINARY_PROBE_SIZE);
    const { bytesRead } = await fd.read(buf, 0, BINARY_PROBE_SIZE, 0);
    return isBinaryBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fd.close();
  }
}

export function fileToContentPart(
  path: string,
  mimeType: string,
  binary?: boolean,
): Extract<ContentPart, { path: string }> {
  // binary probe is authoritative: .ts → "video/mp2t" is a known MIME misdetection
  if (binary === false) return { type: "text_file", path, mimeType };
  if (mimeType.startsWith("image/")) return { type: "image_file", path, mimeType };
  if (mimeType.startsWith("audio/")) return { type: "audio_file", path, mimeType };
  if (mimeType.startsWith("video/")) return { type: "video_file", path, mimeType };
  if (binary === true) return { type: "file", path, mimeType };
  return { type: "file", path, mimeType };
}
