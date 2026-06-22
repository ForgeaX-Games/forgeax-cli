import { readFile } from "node:fs/promises";
import type { ContentPart } from "../core/types.js";
import { isFileMediaContentPart, isInlineMediaContentPart } from "../core/types.js";
import { sandboxFs } from "../sandbox/fs-bridge.js";

type MediaInputPart = Extract<ContentPart, {
  type: "image" | "image_file" | "audio" | "audio_file" | "video" | "video_file";
}>;

export async function readMediaBytes(
  part: MediaInputPart,
): Promise<{ bytes: Buffer; mimeType: string; label: string }> {
  if (isFileMediaContentPart(part)) {
    // Default = container view (via sandboxFs bridge, which fast-paths bind-mount
    // paths to host readFile). Only skip the bridge when producer explicitly
    // marks this as a pure host path. See FileMediaContentPart JSDoc.
    const bytes = part.inContainer === false
      ? await readFile(part.path)
      : await sandboxFs.readBinary(part.path);
    return { bytes, mimeType: part.mimeType, label: part.path };
  }
  if (isInlineMediaContentPart(part)) {
    return {
      bytes: Buffer.from(part.data, "base64"),
      mimeType: part.mimeType,
      label: `inline ${part.type}`,
    };
  }
  return { bytes: Buffer.alloc(0), mimeType: "application/octet-stream", label: "unknown media" };
}

/**
 * Read arbitrary file from disk and return bytes + mimeType.
 * Works with any ContentPart that has a `path` property.
 */
export async function readFileBytes(
  part: Extract<ContentPart, { path: string }>,
): Promise<{ bytes: Buffer; mimeType: string; label: string }> {
  const bytes = await readFile(part.path);
  return { bytes, mimeType: part.mimeType, label: part.path };
}
