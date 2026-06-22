/**
 * media-normalizer.ts — Sanitize inline media content parts in replayed messages.
 *
 * Only validates inline media (image/video/audio) magic bytes — catches
 * corrupted base64 early so provider inline conversion doesn't receive garbage.
 *
 * **Path-based parts are NOT sanitized here.** The `FileMediaContentPart` / `file` /
 * `text_file` contract says the producer is responsible for the path owner
 * (see `FileMediaContentPart.inContainer` in src/core/types.ts). Reachability
 * is decided at consumption time (`readMediaBytes` / `readFileBytes`) — if the
 * file is gone, provider adapters catch the read error and surface a
 * placeholder. No duplicate accessibility check upstream.
 */

import {
  isInlineMediaContentPart,
  type ContentPart,
} from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";

export async function sanitizeMedia(messages: LLMMessage[]): Promise<LLMMessage[]> {
  const result: LLMMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content) || msg.content.length === 0) {
      result.push(msg);
      continue;
    }
    let changed = false;
    const content: ContentPart[] = [];
    for (const part of msg.content) {
      const sanitized = sanitizePart(part);
      if (sanitized !== part) changed = true;
      content.push(sanitized);
    }
    result.push(changed ? { ...msg, content } : msg);
  }
  return result;
}

function sanitizePart(part: ContentPart): ContentPart {
  if (!isInlineMediaContentPart(part)) return part;

  if (part.type === "image" && !looksLikeImage(part.data)) {
    return { type: "text", text: `[image corrupted: data is not a valid image (declared ${part.mimeType})]` };
  }
  if (part.type === "audio" && !looksLikeAudio(part.data)) {
    return { type: "text", text: `[audio corrupted: data is not a valid audio (declared ${part.mimeType})]` };
  }
  if (part.type === "video" && !looksLikeVideo(part.data)) {
    return { type: "text", text: `[video corrupted: data is not a valid video (declared ${part.mimeType})]` };
  }
  return part;
}

// ─── Magic bytes detection (base64 prefix matching) ─────────────────────────
//
// Checking the base64 prefix avoids decoding the entire payload.
// Each entry maps to the raw-byte signature of a common format.

const IMAGE_PREFIXES = [
  "/9j/",      // JPEG  (FF D8 FF)
  "iVBOR",     // PNG   (89 50 4E 47)
  "R0lGOD",    // GIF   (47 49 46 38)
  "UklGR",     // RIFF  (WebP container: 52 49 46 46)
  "Qk",        // BMP   (42 4D)
];

const AUDIO_PREFIXES = [
  "SUQz",      // ID3   (MP3 with ID3 tag: 49 44 33)
  "//s",       // MP3 frame sync (FF FB)
  "//k",       // MP3 frame sync (FF F3)
  "//I",       // MP3 frame sync (FF F2)
  "T2dnU",     // OGG   (4F 67 67 53)
  "ZkxhQ",     // FLAC  (66 4C 61 43)
  "UklGR",     // RIFF  (WAV container: 52 49 46 46)
  "//E",       // AAC ADTS (FF F1)
  "//k",       // AAC ADTS (FF F9)
  "AAAA",      // AAC raw / M4A atom (common leading zeros)
];

const VIDEO_PREFIXES = [
  "AAAA",      // MP4/MOV (ftyp atom, leading size bytes 00 00 00)
  "GkXf",      // WebM/MKV (EBML header: 1A 45 DF A3)
  "UklGR",     // AVI  (RIFF container: 52 49 46 46)
  "Zmxh",      // FLV  (46 4C 56)
];

function matchesAnyPrefix(data: string, prefixes: string[]): boolean {
  if (!data || data.length < 4) return false;
  return prefixes.some((p) => data.startsWith(p));
}

function looksLikeImage(data: string): boolean {
  return matchesAnyPrefix(data, IMAGE_PREFIXES);
}

function looksLikeAudio(data: string): boolean {
  return matchesAnyPrefix(data, AUDIO_PREFIXES);
}

function looksLikeVideo(data: string): boolean {
  return matchesAnyPrefix(data, VIDEO_PREFIXES);
}
