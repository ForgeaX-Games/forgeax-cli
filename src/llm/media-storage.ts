// @desc Single dispatch point for reading media bytes — also reconciles declared mime against magic bytes

import { readFile } from "node:fs/promises";
import type { ContentPart } from "../core/types.js";
import { isFileMediaContentPart, isInlineMediaContentPart } from "../core/types.js";
import { sandboxFs } from "../sandbox/fs-bridge.js";
import { coerceMimeBySniff } from "./media-mime-sniff.js";

type MediaInputPart = Extract<ContentPart, {
  type: "image" | "image_file" | "audio" | "audio_file" | "video" | "video_file";
}>;

/** Read bytes + reconciled mime for a media part.
 *
 *  Producers infer mime from file extension (which can lie — e.g. a `.png`
 *  that actually contains JPEG bytes). This function sniffs the first ~32
 *  bytes against magic-byte signatures and returns the corrected mime.
 *
 *  Consumers MUST use the returned `mimeType`, not `part.mimeType` — otherwise
 *  any extension-derived mime lie reaches the LLM API and triggers HTTP 400.
 *
 *  This is the single dispatch point for file media bytes across all provider
 *  adapters (anthropic / openai-compat / openai-response / gemini-shared). */
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
    const mimeType = coerceMimeBySniff(bytes, part.mimeType, part.path);
    return { bytes, mimeType, label: part.path };
  }
  if (isInlineMediaContentPart(part)) {
    const bytes = Buffer.from(part.data, "base64");
    const mimeType = coerceMimeBySniff(bytes, part.mimeType, `inline ${part.type}`);
    return { bytes, mimeType, label: `inline ${part.type}` };
  }
  return { bytes: Buffer.alloc(0), mimeType: "application/octet-stream", label: "unknown media" };
}

/** Read arbitrary file from disk and return bytes + reconciled mime.
 *
 *  Works with any ContentPart that has a `path` property (text_file / file /
 *  *_file). Path ownership matches `readMediaBytes`:
 *   - `inContainer === false` → host fs via `node:fs.readFile`
 *   - otherwise (default) → container view via `sandboxFs.readBinary` bridge
 *
 *  For binary types the sniff corrects mime via magic bytes; for text files
 *  the sniff returns null and the declared mime is preserved.
 *
 *  Consumers MUST use the returned `mimeType`, not `part.mimeType`. */
export async function readFileBytes(
  part: Extract<ContentPart, { path: string }>,
): Promise<{ bytes: Buffer; mimeType: string; label: string }> {
  const inContainerFlag = (part as { inContainer?: boolean }).inContainer;
  const bytes = inContainerFlag === false
    ? await readFile(part.path)
    : await sandboxFs.readBinary(part.path);
  const mimeType = coerceMimeBySniff(bytes, part.mimeType, part.path);
  return { bytes, mimeType, label: part.path };
}
