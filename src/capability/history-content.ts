/**
 * Provider-neutral history content.
 *
 * TurnMessage is deliberately an open contract, so persisted history can
 * contain the nine ContentPart variants as well as blocks written by an older
 * provider adapter.  This file is the one place where that input is interpreted
 * before it reaches a provider.  Providers must consume the neutral `data` /
 * `mimeType` media shape; Anthropic's `source` shape is only a boundary
 * compatibility form and is never the canonical history representation.
 *
 * Security invariants:
 * - only content/result/envelope are recursive content-bearing fields;
 * - tool_use.input and every tool argument field remain opaque;
 * - host paths are read with a bounded fd reader and never appear in markers;
 * - malformed, missing, oversized, unknown, or provider-incompatible content
 *   becomes an explicit path-free text marker instead of being dropped.
 */
import { statSync } from 'node:fs';
import { extname } from 'node:path';
import {
  bytesToBase64,
  hasCompleteImageStructure,
  imageBlockFromFilePart,
  imageMediaTypeFromMagic,
  IMAGE_FILE_UNAVAILABLE_TEXT,
  readFilePathBounded,
  type ImageFileStat,
} from './image-block';
import {
  base64LengthOfRaw,
  IMAGE_MAX_B64_BYTES,
  IMAGE_TARGET_RAW_BYTES,
} from './image-scale-policy';

// ─── public neutral shapes ───────────────────────────────────────────────────

export type NeutralMediaType = 'image' | 'audio' | 'video' | 'file' | 'document';

export interface NeutralTextPart {
  type: 'text';
  text: string;
}

export interface NeutralMediaPart {
  type: NeutralMediaType;
  data: string;
  mimeType: string;
  name?: string;
}

export interface NeutralToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  /** Opaque tool arguments. Never canonicalize or inspect recursively. */
  input: unknown;
  content?: unknown;
}

export interface NeutralToolResultPart {
  type: 'tool_result';
  tool_use_id: string;
  name?: string;
  content: unknown;
  is_error?: boolean;
}

export type NeutralContentPart =
  | NeutralTextPart
  | NeutralMediaPart
  | NeutralToolUsePart
  | NeutralToolResultPart
  // Thinking is a provider-neutral replayable block already understood by the
  // adapters; it is not one of the nine ContentPart producer variants.
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'server_tool_use'; id?: string; name?: string; input?: unknown };

export interface HistoryUserMessage {
  role: 'user';
  content: unknown;
}

export interface HistoryAssistantMessage {
  role: 'assistant';
  content: unknown;
  toolCalls?: Array<{ callId: string; name: string; args?: unknown }>;
}

export interface HistoryToolMessage {
  role: 'tool';
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type HistoryMessage = HistoryUserMessage | HistoryAssistantMessage | HistoryToolMessage;

export interface CanonicalHistoryMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export const HISTORY_CONTENT_MAX_RAW_BYTES = IMAGE_TARGET_RAW_BYTES;
export const HISTORY_CONTENT_MAX_B64_BYTES = IMAGE_MAX_B64_BYTES;

export const HISTORY_MARKERS = {
  unavailable: '[content unavailable]',
  invalid: '[content unavailable: invalid format]',
  oversized: '[content unavailable: size limit exceeded]',
  unsupported: '[content unavailable: unsupported type]',
  empty: '[content unavailable: empty content]',
  toolError: '[tool result unavailable]',
  toolNameMissing: '[tool result unavailable: missing tool name]',
} as const;

// ─── small guards and safe byte helpers ──────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeHostPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function looksLikeHostPath(value: unknown): boolean {
  return typeof value === 'string' && (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    /^file:\/\//i.test(value) ||
    /^[a-z]:[\\/]/i.test(value)
  );
}

function normalizedMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mime)) return undefined;
  return mime;
}

function mimeFromExtension(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.txt':
    case '.md':
    case '.markdown':
    case '.csv':
    case '.log':
    case '.tsv':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.xml':
      return 'application/xml';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    default:
      return undefined;
  }
}

function sniffMime(bytes: Uint8Array): string | undefined {
  const image = imageMediaTypeFromMagic(bytes);
  if (image) return image;
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  ) {
    return 'audio/wav';
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'audio/ogg';
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
  ) {
    return 'audio/mpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return 'audio/flac';
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm';
  }
  return undefined;
}

function isTextMime(mime: string | undefined): boolean {
  return Boolean(mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml'));
}

function categoryForMime(mime: string | undefined): NeutralMediaType | undefined {
  if (!mime) return undefined;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return 'file';
}

function base64IsCanonical(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  let encoded = value;
  const dataUrl = /^data:([^;,]+)?;base64,(.*)$/s.exec(value);
  if (dataUrl) encoded = dataUrl[2];
  if (!base64IsCanonical(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || base64LengthOfRaw(bytes.length) !== encoded.length) return null;
    return bytes;
  } catch {
    return null;
  }
}

function safeInlineText(value: unknown): NeutralTextPart | null {
  return typeof value === 'string' && value.length > 0 ? { type: 'text', text: value } : null;
}

function marker(marker: string): NeutralTextPart {
  return { type: 'text', text: marker };
}

function safeDataUrl(value: unknown): { data: string; mimeType: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return null;
  const mimeType = normalizedMime(match[1]);
  const bytes = decodeBase64(match[2]);
  if (!mimeType || !bytes || bytes.length > HISTORY_CONTENT_MAX_RAW_BYTES || base64LengthOfRaw(bytes.length) > HISTORY_CONTENT_MAX_B64_BYTES) return null;
  return { data: bytesToBase64(bytes), mimeType };
}

function statPath(path: string): ImageFileStat {
  return { size: statSync(path).size };
}

function readBounded(path: string): Uint8Array | null {
  if (!isSafeHostPath(path)) return null;
  const bytes = readFilePathBounded(path, HISTORY_CONTENT_MAX_RAW_BYTES + 1);
  if (!bytes || bytes.length > HISTORY_CONTENT_MAX_RAW_BYTES || base64LengthOfRaw(bytes.length) > HISTORY_CONTENT_MAX_B64_BYTES) return null;
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) return null;
    return text;
  } catch {
    return null;
  }
}

function mediaPart(type: NeutralMediaType, bytes: Uint8Array, mimeType: string, name?: string): NeutralMediaPart | null {
  if (bytes.length === 0 || bytes.length > HISTORY_CONTENT_MAX_RAW_BYTES || base64LengthOfRaw(bytes.length) > HISTORY_CONTENT_MAX_B64_BYTES) return null;
  const actual = sniffMime(bytes);
  const declaredCategory = categoryForMime(mimeType);
  const actualCategory = categoryForMime(actual);
  if (declaredCategory && declaredCategory !== type && !(type === 'file' && declaredCategory === 'document')) return null;
  if (actualCategory && actualCategory !== type && !(type === 'file' && actualCategory === 'document')) return null;
  if (type === 'image') {
    const imageMime = imageMediaTypeFromMagic(bytes);
    if (!imageMime || !hasCompleteImageStructure(bytes, imageMime)) return null;
    return { type, data: bytesToBase64(bytes), mimeType: imageMime, ...(name ? { name } : {}) };
  }
  if (type === 'document' && actual !== 'application/pdf') return null;
  if (type === 'audio' || type === 'video') {
    if (!actual || categoryForMime(actual) !== type) return null;
    return { type, data: bytesToBase64(bytes), mimeType: actual, ...(name ? { name } : {}) };
  }
  return { type, data: bytesToBase64(bytes), mimeType: actual ?? mimeType, ...(name ? { name } : {}) };
}

function canonicalInlinePart(
  type: NeutralMediaType,
  data: unknown,
  mime: unknown,
  name?: string,
): NeutralMediaPart | null {
  let mediaType = normalizedMime(mime);
  let raw = data;
  if (typeof data === 'string') {
    const parsed = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    if (parsed) {
      mediaType ??= normalizedMime(parsed[1]);
      raw = parsed[2];
    }
  }
  const bytes = decodeBase64(raw);
  if (!bytes || !mediaType) return null;
  return mediaPart(type, bytes, mediaType, name);
}

type PathContentType = 'text_file' | NeutralMediaType;

function canonicalPathPart(type: PathContentType, part: Record<string, unknown>): NeutralContentPart {
  const path = part.path;
  const unavailable = () => marker(type === 'image' ? IMAGE_FILE_UNAVAILABLE_TEXT : HISTORY_MARKERS.unavailable);
  if (!isSafeHostPath(path)) return unavailable();
  const declared = normalizedMime(part.mimeType ?? part.mediaType) ?? mimeFromExtension(path);

  if (type === 'image') {
    const block = imageBlockFromFilePart(part, readFilePathBounded, statPath);
    if (!block) return unavailable();
    const source = block.source;
    return { type: 'image', data: source.data, mimeType: source.media_type };
  }

  const bytes = readBounded(path);
  if (!bytes) return marker(HISTORY_MARKERS.unavailable);
  if (type === 'text_file') {
    const textMime = declared ?? 'text/plain';
    if (!isTextMime(textMime) || sniffMime(bytes) && !isTextMime(sniffMime(bytes))) return marker(HISTORY_MARKERS.invalid);
    const text = decodeUtf8(bytes);
    return text === null || text.length === 0 ? marker(HISTORY_MARKERS.invalid) : { type: 'text', text };
  }

  const actual = sniffMime(bytes);
  const targetType = type === 'file' ? categoryForMime(actual ?? declared) ?? 'file' : type;
  const mediaMime = actual ?? declared;
  if (!mediaMime) return marker(HISTORY_MARKERS.invalid);
  const partResult = mediaPart(targetType, bytes, mediaMime);
  return partResult ?? marker(HISTORY_MARKERS.invalid);
}

function canonicalDocumentPart(part: Record<string, unknown>): NeutralContentPart {
  if (typeof part.path === 'string') return canonicalPathPart('document', part);
  const source = isRecord(part.source) ? part.source : undefined;
  const data = source?.data ?? part.data ?? part.file_data;
  const mime = normalizedMime(source?.media_type ?? source?.mimeType ?? part.mimeType ?? part.mediaType) ?? 'application/pdf';
  const inline = canonicalInlinePart('document', data, mime, typeof part.name === 'string' ? part.name : undefined);
  return inline ?? marker(HISTORY_MARKERS.invalid);
}

function canonicalProviderImage(part: Record<string, unknown>): NeutralContentPart | null {
  const source = isRecord(part.source) ? part.source : undefined;
  const imageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
  const data = source?.data ?? (typeof imageUrl === 'string' ? imageUrl : part.data);
  const mime = source?.media_type ?? part.mimeType ?? part.mediaType;
  if (source?.type === 'url' || (typeof data === 'string' && /^https?:\/\//i.test(data))) return null;
  return canonicalInlinePart('image', data, mime);
}

function canonicalProviderFile(part: Record<string, unknown>): NeutralContentPart | null {
  const file = isRecord(part.file) ? part.file : undefined;
  const data = file?.file_data ?? file?.data ?? part.file_data ?? part.data;
  const mime = normalizedMime(file?.mimeType ?? part.mimeType ?? part.mediaType);
  if (typeof data === 'string' && /^https?:\/\//i.test(data)) return null;
  const safe = safeDataUrl(data);
  if (safe) {
    const target = categoryForMime(mime ?? safe.mimeType) ?? 'file';
    return canonicalInlinePart(target, safe.data, mime ?? safe.mimeType);
  }
  // Canonical neutral file/document blocks intentionally carry raw base64
  // (`data` + `mimeType`), not a provider data URL.  Accept that shape on
  // every pass so boundary normalization is idempotent.
  if (mime && typeof data === 'string') {
    const target = categoryForMime(mime) ?? 'file';
    return canonicalInlinePart(target, data, mime);
  }
  return null;
}

function canonicalProviderAudio(part: Record<string, unknown>): NeutralContentPart | null {
  const audio = isRecord(part.input_audio) ? part.input_audio : part;
  const format = typeof audio.format === 'string' ? audio.format.toLowerCase() : undefined;
  const mime = normalizedMime(part.mimeType ?? part.mediaType) ?? (format ? `audio/${format === 'mp3' ? 'mpeg' : format}` : undefined);
  return canonicalInlinePart('audio', audio.data, mime);
}

function canonicalizeProviderBlock(part: Record<string, unknown>): NeutralContentPart | NeutralContentPart[] | null {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
      return safeInlineText(part.text) ?? marker(HISTORY_MARKERS.empty);
    case 'image_url':
    case 'input_image':
      return canonicalProviderImage(part) ?? marker(HISTORY_MARKERS.invalid);
    case 'input_file':
    case 'file_data':
      return canonicalProviderFile(part) ?? marker(HISTORY_MARKERS.invalid);
    case 'input_audio':
      return canonicalProviderAudio(part) ?? marker(HISTORY_MARKERS.invalid);
    case 'inlineData': {
      const mime = normalizedMime(part.mimeType);
      const type = categoryForMime(mime);
      if (!type || type === 'document' || type === 'file') return canonicalInlinePart('file', part.data, mime) ?? marker(HISTORY_MARKERS.invalid);
      return canonicalInlinePart(type, part.data, mime) ?? marker(HISTORY_MARKERS.invalid);
    }
    case 'functionCall': {
      const call = isRecord(part.functionCall) ? part.functionCall : part;
      const name = typeof call.name === 'string' && call.name.trim() ? call.name.trim() : 'unnamed_tool';
      return {
        type: 'tool_use',
        id: typeof call.id === 'string' && call.id ? call.id : typeof part.id === 'string' ? part.id : `gemini-call-${name}`,
        name,
        input: call.args ?? call.input ?? {},
      };
    }
    case 'functionResponse': {
      const response = isRecord(part.functionResponse) ? part.functionResponse : part;
      const content = response.response && isRecord(response.response)
        ? response.response.result ?? response.response
        : response.result ?? response.content;
      return {
        type: 'tool_result',
        tool_use_id: typeof response.id === 'string' ? response.id : typeof part.id === 'string' ? part.id : '',
        ...(typeof response.name === 'string' && response.name ? { name: response.name } : {}),
        content: canonicalizeContent(content) ?? marker(HISTORY_MARKERS.toolError),
      };
    }
    case 'tool_calls': {
      if (!Array.isArray(part.tool_calls)) return marker(HISTORY_MARKERS.invalid);
      const calls: NeutralContentPart[] = [];
      for (const call of part.tool_calls) {
        if (!isRecord(call)) {
          calls.push(marker(HISTORY_MARKERS.invalid));
          continue;
        }
        const fn = isRecord(call.function) ? call.function : call;
        let input: unknown = fn.arguments ?? fn.input ?? {};
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* keep opaque string */ }
        }
        calls.push({
          type: 'tool_use' as const,
          id: typeof call.id === 'string' ? call.id : 'unnamed-call',
          name: typeof fn.name === 'string' && fn.name ? fn.name : 'unnamed_tool',
          input,
        });
      }
      return calls.length > 0 ? calls : marker(HISTORY_MARKERS.empty);
    }
    default:
      return null;
  }
}

function canonicalizeRecord(part: Record<string, unknown>): NeutralContentPart | NeutralContentPart[] | Record<string, unknown> | null {
  const type = typeof part.type === 'string' ? part.type : undefined;
  switch (type) {
    // The nine producer ContentPart variants.  File variants are consumed here,
    // never passed downstream with their host path.
    case 'text':
      return safeInlineText(part.text);
    case 'text_file':
      return canonicalPathPart('text_file', part);
    case 'file':
      if (typeof part.path === 'string') return canonicalPathPart('file', part);
      return canonicalProviderFile(part) ?? marker(HISTORY_MARKERS.invalid);
    case 'image': {
      if (isRecord(part.source) || isRecord(part.image_url)) return canonicalProviderImage(part) ?? marker(HISTORY_MARKERS.invalid);
      return canonicalInlinePart('image', part.data, part.mimeType ?? part.mediaType, typeof part.name === 'string' ? part.name : undefined) ?? marker(HISTORY_MARKERS.invalid);
    }
    case 'video':
      return canonicalInlinePart('video', part.data, part.mimeType ?? part.mediaType, typeof part.name === 'string' ? part.name : undefined) ?? marker(HISTORY_MARKERS.invalid);
    case 'audio':
      return canonicalInlinePart('audio', part.data, part.mimeType ?? part.mediaType, typeof part.name === 'string' ? part.name : undefined) ?? marker(HISTORY_MARKERS.invalid);
    case 'image_file':
      return canonicalPathPart('image', part);
    case 'video_file':
      return canonicalPathPart('video', part);
    case 'audio_file':
      return canonicalPathPart('audio', part);

    // Legacy/provider-shaped content.  These branches are intentionally
    // explicit so an Anthropic block cannot become the neutral contract.
    case 'document':
      return canonicalDocumentPart(part);
    case 'input_text':
    case 'output_text':
    case 'image_url':
    case 'input_image':
    case 'input_file':
    case 'file_data':
    case 'input_audio':
    case 'inlineData':
    case 'functionCall':
    case 'functionResponse':
    case 'tool_calls':
      return canonicalizeProviderBlock(part);
    case 'tool_use': {
      const id = typeof part.id === 'string' && part.id ? part.id : 'unnamed-call';
      const name = typeof part.name === 'string' && part.name.trim() ? part.name.trim() : 'unnamed_tool';
      // input is deliberately copied as an opaque value.
      const out: NeutralToolUsePart = { type: 'tool_use', id, name, input: part.input ?? {} };
      if (Object.prototype.hasOwnProperty.call(part, 'content')) out.content = canonicalizeContent(part.content);
      return out;
    }
    case 'tool_result': {
      const callId = typeof part.tool_use_id === 'string' ? part.tool_use_id : typeof part.call_id === 'string' ? part.call_id : '';
      const result = canonicalizeContent(part.content ?? part.result) ?? marker(HISTORY_MARKERS.toolError);
      return {
        type: 'tool_result',
        tool_use_id: callId,
        ...(typeof part.name === 'string' && part.name ? { name: part.name } : {}),
        content: result,
        ...(typeof part.is_error === 'boolean' ? { is_error: part.is_error } : {}),
      };
    }
    case 'thinking':
      return typeof part.thinking === 'string' ? { type: 'thinking', thinking: part.thinking, ...(typeof part.signature === 'string' ? { signature: part.signature } : {}) } : marker(HISTORY_MARKERS.invalid);
    case 'redacted_thinking':
      return typeof part.data === 'string' ? { type: 'redacted_thinking', data: part.data } : marker(HISTORY_MARKERS.invalid);
    case 'server_tool_use':
      return { type: 'server_tool_use', ...(typeof part.id === 'string' ? { id: part.id } : {}), ...(typeof part.name === 'string' ? { name: part.name } : {}), input: part.input };
    default:
      break;
  }

  // A result/envelope can wrap content several times.  Recurse only through
  // those named fields; arbitrary metadata and tool arguments are not content.
  const contentKeys = ['content', 'result', 'envelope'] as const;
  const present = contentKeys.filter((key) => Object.prototype.hasOwnProperty.call(part, key));
  if (present.length > 0) {
    // These are content envelopes, not provider blocks.  Flatten them here so
    // adapters never receive `{content:[...]}` and silently discard the
    // actual parts.  Only the explicitly content-bearing keys are traversed;
    // arbitrary metadata remains outside the canonical content contract.
    const flattened: unknown[] = [];
    for (const key of present) {
      const normalized = canonicalizeContent(part[key]);
      if (Array.isArray(normalized)) flattened.push(...normalized);
      else if (normalized !== null && normalized !== undefined) flattened.push(normalized);
    }
    return flattened.length === 0
      ? marker(HISTORY_MARKERS.empty)
      : flattened.length === 1
        ? flattened[0] as NeutralContentPart
        : flattened as NeutralContentPart[];
  }
  return marker(HISTORY_MARKERS.unsupported);
}

/** Canonicalize content recursively without traversing tool arguments. */
export function canonicalizeContent(content: unknown): unknown {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (content === null || content === undefined) return null;
  if (Array.isArray(content)) {
    const out: unknown[] = [];
    for (const part of content) {
      const normalized = canonicalizeContent(part);
      if (normalized === null || normalized === undefined) continue;
      if (Array.isArray(normalized)) out.push(...normalized);
      else out.push(normalized);
    }
    return out;
  }
  if (!isRecord(content)) return marker(HISTORY_MARKERS.unsupported);
  return canonicalizeRecord(content);
}

function collectToolNames(value: unknown, names: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const part of value) collectToolNames(part, names);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'tool_use' && typeof value.id === 'string') {
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'unnamed_tool';
    names.set(value.id, name);
    collectToolNames(value.content, names);
    return;
  }
  if (value.type === 'functionCall' && isRecord(value.functionCall)) {
    const call = value.functionCall;
    const id = typeof call.id === 'string' ? call.id : typeof value.id === 'string' ? value.id : undefined;
    if (id) names.set(id, typeof call.name === 'string' && call.name ? call.name : 'unnamed_tool');
    return;
  }
  if (value.type === 'tool_calls' && Array.isArray(value.tool_calls)) {
    for (const raw of value.tool_calls) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : raw;
      const id = typeof raw.id === 'string' ? raw.id : undefined;
      if (id) names.set(id, typeof fn.name === 'string' && fn.name.trim() ? fn.name.trim() : 'unnamed_tool');
    }
    return;
  }
  for (const key of ['content', 'result', 'envelope']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectToolNames(value[key], names);
  }
}

function contentHasParts(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content !== null && content !== undefined;
}

function canonicalMessageContent(content: unknown): unknown {
  const normalized = canonicalizeContent(content);
  // ProviderMessage content is historically string | array | unknown. Keep
  // strings as strings, but make a single canonical block a one-item part
  // list so every adapter can apply the same block mapping logic.
  return isRecord(normalized) && typeof normalized.type === 'string' ? [normalized] : normalized;
}

function appendAssistantToolCalls(content: unknown, calls: HistoryAssistantMessage['toolCalls']): unknown {
  if (!calls || calls.length === 0) return content;
  const blocks = Array.isArray(content)
    ? [...content]
    : typeof content === 'string' && content.length > 0
      ? [{ type: 'text', text: content }]
      : contentHasParts(content)
        ? [content]
        : [];
  const ids = new Set(blocks.filter(isRecord).map((block) => block.type === 'tool_use' && typeof block.id === 'string' ? block.id : undefined));
  for (const call of calls) {
    const id = typeof call.callId === 'string' && call.callId ? call.callId : 'unnamed-call';
    if (ids.has(id)) continue;
    blocks.push({
      type: 'tool_use',
      id,
      name: typeof call.name === 'string' && call.name.trim() ? call.name.trim() : 'unnamed_tool',
      // Keep args opaque, including a string that happens to contain a path.
      input: call.args ?? {},
    });
    ids.add(id);
  }
  return blocks;
}

/**
 * Convert host-owned TurnMessage history to provider-neutral messages.  The
 * provider contract historically represents tool results as user messages
 * containing a `tool_result` block, so that compatibility shape is retained.
 */
export function canonicalizeHistory(history: HistoryMessage[] | undefined): CanonicalHistoryMessage[] {
  if (!history) return [];
  const toolNames = new Map<string, string>();
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (typeof call.callId === 'string' && call.callId) {
          toolNames.set(call.callId, typeof call.name === 'string' && call.name.trim() ? call.name.trim() : 'unnamed_tool');
        }
      }
      collectToolNames(message.content, toolNames);
    }
  }

  const out: CanonicalHistoryMessage[] = [];
  for (const message of history) {
    if (message.role === 'user') {
      const content = canonicalMessageContent(message.content);
      if (contentHasParts(content)) out.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      const content = appendAssistantToolCalls(canonicalMessageContent(message.content), message.toolCalls);
      // Empty assistant turns are omitted.  A tool-only turn has tool_use blocks
      // and therefore remains present without manufacturing an empty text block.
      if (contentHasParts(content)) out.push({ role: 'assistant', content });
      continue;
    }

    const result = canonicalMessageContent(message.result);
    const content = contentHasParts(result) ? result : marker(message.ok ? HISTORY_MARKERS.empty : HISTORY_MARKERS.toolError);
    const callId = typeof message.callId === 'string' ? message.callId : '';
    const name = toolNames.get(callId);
    out.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: callId,
        ...(name ? { name } : {}),
        content,
        is_error: !message.ok,
      } satisfies NeutralToolResultPart],
    });
  }
  return out;
}

/**
 * Boundary helper for direct ProviderMessage seeds/current-turn content.  It
 * applies the same media/path safety rules while retaining known provider
 * thinking/tool blocks for the adapter-specific mapper.
 */
export function canonicalizeBoundaryContent(content: unknown): unknown {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map(visit)
        .flatMap((item) => (Array.isArray(item) ? item : item === null || item === undefined ? [] : [item]));
    }
    if (!isRecord(value)) return value;

    // Current-turn callers historically use Anthropic's source-shaped image /
    // document blocks.  Keep those exact blocks for the provider boundary;
    // history canonicalization never emits them.
    if ((value.type === 'image' || value.type === 'document') && isRecord(value.source)) {
      // Keep the established current-turn Anthropic source compatibility, but
      // never preserve a source that is actually a host reference.
      if (looksLikeHostPath(value.source.path) || looksLikeHostPath(value.source.url)) {
        return marker(HISTORY_MARKERS.unavailable);
      }
      return value;
    }

    if (value.type === 'tool_use') {
      const out: Record<string, unknown> = { ...value };
      if (Object.prototype.hasOwnProperty.call(value, 'content')) out.content = visit(value.content);
      return out;
    }
    if (value.type === 'tool_result') {
      const out: Record<string, unknown> = { ...value };
      const nested: unknown[] = [];
      for (const key of ['content', 'result', 'envelope'] as const) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const normalized = visit(value[key]);
        if (Array.isArray(normalized)) nested.push(...normalized);
        else if (normalized !== null && normalized !== undefined) nested.push(normalized);
        delete out[key];
      }
      out.content = nested.length === 0
        ? marker(HISTORY_MARKERS.toolError)
        : nested.length === 1
          ? nested[0]
          : nested;
      return out;
    }

    // Provider-shaped blocks are accepted at the boundary for old seeds, but
    // are converted into the same neutral contract as history.  This prevents
    // a provider-specific file/image block from bypassing the path and magic
    // checks.  Tool arguments remain opaque inside the canonical branches.
    if (
      value.type === 'thinking' || value.type === 'redacted_thinking' || value.type === 'server_tool_use' ||
      value.type === 'image_url' || value.type === 'input_image' || value.type === 'input_file' ||
      value.type === 'input_audio' || value.type === 'inlineData' || value.type === 'functionCall' ||
      value.type === 'functionResponse' || value.type === 'tool_calls' || value.type === 'input_text' ||
      value.type === 'output_text'
    ) {
      return canonicalizeContent(value) ?? marker(HISTORY_MARKERS.unsupported);
    }

    // Path-backed and neutral producer blocks go through the strict reader.
    if (
      value.type === 'image_file' || value.type === 'file' || value.type === 'text_file' ||
      value.type === 'audio_file' || value.type === 'video_file' ||
      ((value.type === 'image' || value.type === 'audio' || value.type === 'video') && !isRecord(value.source)) ||
      value.type === 'document'
    ) {
      return canonicalizeContent(value);
    }

    const keys = ['content', 'result', 'envelope'] as const;
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
      const flattened: unknown[] = [];
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const normalized = visit(value[key]);
        if (Array.isArray(normalized)) flattened.push(...normalized);
        else if (normalized !== null && normalized !== undefined) flattened.push(normalized);
      }
      if (flattened.length === 0) return marker(HISTORY_MARKERS.empty);
      return flattened.length === 1 ? flattened[0] : flattened;
    }
    return value;
  };
  return visit(content);
}
