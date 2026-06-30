/** media-normalizer —— 反向 inflate 后的 inline media 兜底校验。
 *
 *  与 agenteam ref 1:1：
 *  - 只校验 inline media（image / video / audio）的 base64 magic prefix；坏掉的
 *    转成 text 占位，避免 provider inline 转换吃到垃圾后报模糊错误。
 *  - 不验 file-based parts（FileMediaContentPart / file / text_file），那是 producer
 *    的责任；reachability 在 readMediaBytes / readFileBytes 消费时再判。
 *
 *  本模块只 import core/types 的 type guards + llm/types 的 LLMMessage。 */

import { isInlineMediaContentPart, type ContentPart } from "../core/types";
import type { LLMMessage } from "../llm/types";

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

// ── Magic bytes detection (base64 prefix matching) ──────────────────────────

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
  "AAAA",      // AAC raw / M4A atom
];

const VIDEO_PREFIXES = [
  "AAAA",      // MP4/MOV (ftyp atom)
  "GkXf",      // WebM/MKV (EBML header: 1A 45 DF A3)
  "UklGR",     // AVI  (RIFF container)
  "Zmxh",      // FLV  (46 4C 56)
];

function matchesAnyPrefix(data: string, prefixes: string[]): boolean {
  if (!data || data.length < 4) return false;
  return prefixes.some((p) => data.startsWith(p));
}

function looksLikeImage(data: string): boolean { return matchesAnyPrefix(data, IMAGE_PREFIXES); }
function looksLikeAudio(data: string): boolean { return matchesAnyPrefix(data, AUDIO_PREFIXES); }
function looksLikeVideo(data: string): boolean { return matchesAnyPrefix(data, VIDEO_PREFIXES); }
