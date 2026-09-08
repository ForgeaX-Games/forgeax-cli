/**
 * 共享 image-block helper —— 把各种来源(base64 / dataUrl / 原始字节 / 文件路径)
 * 规整成 provider 中立的 image content block(Anthropic `{type:'image',source:{...}}`)。
 *
 * 背景:原先 facade(`kernel-facade/forgeax-core-kernel.ts`)有一份只服务「用户输入
 * 附件」的 `imageBlockFromAttachment`;多模态 `read_file`(011)也要把磁盘图片读成同形
 * image block。为避免两处各写一份、降低与 008 在 facade 的合并冲突,把这套逻辑抽到本
 * 共享文件,facade 与 read_file 共用。
 *
 * Boundary: 仅 import node:fs/path,不引外部包。current-turn/read_file 仍由调用方注入；
 * 历史 provider 边界统一使用本文件的 bounded host-path reader。
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import {
  IMAGE_MAX_B64_BYTES,
  IMAGE_TARGET_RAW_BYTES,
  base64LengthOfRaw,
  sniffImageDims,
} from './image-scale-policy';

/** provider 中立 image content block(Anthropic base64 source 形;openai-compat 会优雅降级)。 */
export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** 由文件扩展名推断 image media_type(兜底 image/png)。 */
export function mediaTypeFromExt(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    default:
      return 'image/png';
  }
}

/** 扩展名是否「看起来是图片」(read_file 的快速判定;无扩展名时再交给 magic-bytes)。 */
export function isImageExt(path: string): boolean {
  switch (extname(path).toLowerCase()) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return true;
    default:
      return false;
  }
}

/** 由文件头魔数判图片类型;非图片返回 null。用于无扩展名 / 扩展名不可信时兜底。 */
export function imageMediaTypeFromMagic(bytes: Uint8Array): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a" (the complete six-byte signature is required).
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function asciiEquals(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function isPngChunkType(bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 4; i++) {
    const value = bytes[offset + i];
    const isUpper = value >= 0x41 && value <= 0x5a;
    const isLower = value >= 0x61 && value <= 0x7a;
    if (!isUpper && !isLower) return false;
  }
  return true;
}

/** PNG must contain complete chunks, IDAT, and an IEND that is the last chunk. */
function hasPngStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || imageMediaTypeFromMagic(bytes) !== 'image/png') return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || !isPngChunkType(bytes, offset + 4)) return false;
    const chunkLength = u32be(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4; // CRC is part of every PNG chunk boundary.
    if (dataEnd < dataStart || chunkEnd < dataEnd || chunkEnd > bytes.length) return false;

    const isIhdr = asciiEquals(bytes, offset + 4, 'IHDR');
    const isIdat = asciiEquals(bytes, offset + 4, 'IDAT');
    const isIend = asciiEquals(bytes, offset + 4, 'IEND');

    if (!sawIhdr) {
      if (!isIhdr || chunkLength !== 13) return false;
      if (u32be(bytes, dataStart) <= 0 || u32be(bytes, dataStart + 4) <= 0) return false;
      sawIhdr = true;
    } else if (isIhdr) {
      return false;
    }

    if (isIdat) {
      if (!sawIhdr || isIend) return false;
      sawIdat = true;
    }

    if (isIend) {
      // IEND has a zero-length data field and must terminate the byte stream.
      return chunkLength === 0 && sawIhdr && sawIdat && chunkEnd === bytes.length;
    }
    offset = chunkEnd;
  }
  return false;
}

function isJpegSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isJpegRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isJpegStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || isJpegRestartMarker(marker);
}

/** JPEG must fully walk segments and entropy-coded scan data through a final EOI. */
function hasJpegStructure(bytes: Uint8Array): boolean {
  if (
    bytes.length < 4 ||
    imageMediaTypeFromMagic(bytes) !== 'image/jpeg' ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return false;
  }

  let offset = 2; // SOI is already validated by imageMediaTypeFromMagic.
  let sawSof = false;
  let sawSos = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0x00) return false; // stuffed bytes are only legal in scan data.

    if (marker === 0xd9) {
      return sawSof && sawSos && offset === bytes.length;
    }
    if (marker === 0xd8 || isJpegRestartMarker(marker)) return false;
    if (isJpegStandaloneMarker(marker)) continue;
    if (offset + 2 > bytes.length) return false;

    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;

    if (isJpegSofMarker(marker)) {
      // length(2) + precision(1) + dimensions(4) + component count(1) + 3 bytes/component
      if (segmentLength < 8) return false;
      const precision = bytes[offset + 2];
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      const components = bytes[offset + 7];
      if (precision === 0 || components === 0 || segmentLength < 8 + components * 3 || width === 0 || height === 0) {
        return false;
      }
      sawSof = true;
      offset += segmentLength;
      continue;
    }

    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }

    // SOS: length(2) + component count(1) + 2 bytes/component + Ss/Se/AhAl(3).
    const components = bytes[offset + 2];
    if (components === 0 || segmentLength < 6 + components * 2) return false;
    sawSos = true;
    offset += segmentLength;

    // Entropy-coded data has no length field. FF00 is a stuffed data byte, restart
    // markers are standalone, and every other marker ends the scan for the outer loop.
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const markerStart = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return false;
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00 || isJpegRestartMarker(scanMarker)) {
        offset++;
        continue;
      }
      // Leave the terminating marker at the outer-loop boundary, including any
      // preceding FF fill bytes. EOI is accepted there only when it is file-final.
      offset = markerStart;
      break;
    }
    if (offset >= bytes.length) return false;
  }
  return false;
}

function readGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < bytes.length) {
    const blockLength = bytes[offset++];
    if (blockLength === 0) return offset;
    if (offset + blockLength > bytes.length) return null;
    offset += blockLength;
  }
  return null;
}

/** GIF must contain a complete image data block and a final trailer. */
function hasGifStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || imageMediaTypeFromMagic(bytes) !== 'image/gif') return false;
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  if (width === 0 || height === 0) return false;

  let offset = 13; // header + logical screen descriptor
  const packed = bytes[10];
  if ((packed & 0x80) !== 0) {
    const colorTableBytes = 3 * (2 << (packed & 0x07));
    if (offset + colorTableBytes > bytes.length) return false;
    offset += colorTableBytes;
  }

  let sawImage = false;
  while (offset < bytes.length) {
    const introducer = bytes[offset];
    if (introducer === 0x3b) {
      return sawImage && offset === bytes.length - 1;
    }
    if (introducer === 0x21) {
      // All GIF extension payloads are data sub-blocks, including the fixed-size
      // first block used by graphic-control/application/plain-text extensions.
      const end = readGifSubBlocks(bytes, offset + 2);
      if (end === null) return false;
      offset = end;
      continue;
    }
    if (introducer !== 0x2c || offset + 10 > bytes.length) return false;

    const imageWidth = u16le(bytes, offset + 5);
    const imageHeight = u16le(bytes, offset + 7);
    if (imageWidth === 0 || imageHeight === 0) return false;
    const imagePacked = bytes[offset + 9];
    offset += 10;
    if ((imagePacked & 0x80) !== 0) {
      const colorTableBytes = 3 * (2 << (imagePacked & 0x07));
      if (offset + colorTableBytes > bytes.length) return false;
      offset += colorTableBytes;
    }
    if (offset >= bytes.length) return false;
    const lzwMinCodeSize = bytes[offset++];
    if (lzwMinCodeSize < 2 || lzwMinCodeSize > 8) return false;
    const end = readGifSubBlocks(bytes, offset);
    if (end === null) return false;
    offset = end;
    sawImage = true;
  }
  return false;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/** WebP must consume the declared RIFF exactly and validate every chunk boundary. */
function hasWebpStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || imageMediaTypeFromMagic(bytes) !== 'image/webp') return false;
  const riffSize = u32le(bytes, 4);
  if (riffSize !== bytes.length - 8) return false;

  let offset = 12;
  let sawImagePayload = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = u32le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const chunkEnd = dataEnd + (chunkSize & 1); // RIFF chunks are word aligned.
    if (dataEnd < dataStart || chunkEnd < dataEnd || chunkEnd > bytes.length) return false;

    if (chunk === 'VP8X') {
      if (chunkSize < 10) return false;
      const width = u24le(bytes, dataStart + 4) + 1;
      const height = u24le(bytes, dataStart + 7) + 1;
      if (width <= 0 || height <= 0) return false;
    } else if (chunk === 'VP8 ') {
      // Frame tag (3) + key-frame start code 9d 01 2a (3) + dimensions (4).
      if (
        chunkSize < 10 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a ||
        (u16le(bytes, dataStart + 6) & 0x3fff) === 0 ||
        (u16le(bytes, dataStart + 8) & 0x3fff) === 0
      ) {
        return false;
      }
      sawImagePayload = true;
    } else if (chunk === 'VP8L') {
      if (chunkSize < 5 || bytes[dataStart] !== 0x2f) return false;
      const bits = u32le(bytes, dataStart + 1);
      if (((bits & 0x3fff) + 1) <= 0 || (((bits >> 14) & 0x3fff) + 1) <= 0) return false;
      sawImagePayload = true;
    }

    offset = chunkEnd;
  }
  return offset === bytes.length && sawImagePayload;
}

/**
 * Validate the complete byte structure of a supported image.  History
 * canonicalization uses this for inline media as well as path-backed media;
 * current-turn attachment callers may continue to use the less strict helper
 * when their producer has already validated the payload.
 */
export function hasCompleteImageStructure(bytes: Uint8Array, mediaType?: string): boolean {
  const dims = sniffImageDims(bytes);
  if (!dims || dims.width <= 0 || dims.height <= 0) return false;
  switch (mediaType ?? imageMediaTypeFromMagic(bytes)) {
    case 'image/png':
      return hasPngStructure(bytes);
    case 'image/jpeg':
      return hasJpegStructure(bytes);
    case 'image/gif':
      return hasGifStructure(bytes);
    case 'image/webp':
      return hasWebpStructure(bytes);
    default:
      return false;
  }
}

/** 把 Uint8Array(已读到内存)转成 base64(不依赖 node:Buffer 形态约束,跑 bun/node 皆可)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  // node / bun 下 Buffer 总在;用它做 base64 最快且不超栈。
  return Buffer.from(bytes).toString('base64');
}

/** base64 + mediaType → image block(已是 base64,直接组块)。 */
export function imageBlockFromBase64(base64: string, mediaType: string): ImageContentBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

/** 原始字节 + 路径(推断 mediaType)→ image block。优先 magic-bytes,回落扩展名。 */
export function imageBlockFromBytes(bytes: Uint8Array, path: string): ImageContentBlock {
  const mediaType = imageMediaTypeFromMagic(bytes) ?? mediaTypeFromExt(path);
  return imageBlockFromBase64(bytesToBase64(bytes), mediaType);
}

/** dataUrl(`data:image/png;base64,xxxx`)→ {data, mediaType};非 dataUrl 返回 null。 */
export function parseDataUrl(s: string): { data: string; mediaType?: string } | null {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  return { data: m[2], mediaType: m[1] || undefined };
}

/** 「用户输入附件」→ {base64, mediaType}。支持两种数据来源:`data`(base64,容忍 dataUrl
 *  前缀)或 `path`(host 文件,经 readPath 读盘)。无数据 / 读盘失败返回 null。
 *  image 与 document 附件共用这段提取逻辑;`mediaTypeFromPath` 由调用方注入
 *  (image 按扩展名推断,document 不传 → 由调用方兜底)。 */
function base64FromAttachment(
  att: Record<string, unknown>,
  readPath: (path: string) => Uint8Array,
  mediaTypeFromPath?: (path: string) => string,
): { data: string; mediaType?: string } | null {
  let data: string | undefined;
  let mediaType = typeof att.mediaType === 'string' ? att.mediaType : undefined;
  if (typeof att.data === 'string' && att.data) {
    const parsed = parseDataUrl(att.data);
    if (parsed) {
      mediaType = mediaType ?? parsed.mediaType;
      data = parsed.data;
    } else {
      data = att.data;
    }
  } else if (typeof att.path === 'string' && att.path) {
    try {
      data = bytesToBase64(readPath(att.path));
      mediaType = mediaType ?? mediaTypeFromPath?.(att.path);
    } catch {
      return null; // 读盘失败 → 跳过该附件(不挂死整轮)
    }
  }
  if (!data) return null;
  return { data, mediaType };
}

/** 「用户输入附件」→ image block(从 facade 抽出,逻辑等价)。
 *  非图片 / 无数据的项返回 null(forward-compat,调用方静默跳过)。
 *  `readPath`:把 host 路径读成字节的注入点(facade 用 node:fs.readFileSync)。 */
export function imageBlockFromAttachment(
  att: Record<string, unknown>,
  readPath: (path: string) => Uint8Array,
): ImageContentBlock | null {
  if (att.kind !== 'image') return null;
  const src = base64FromAttachment(att, readPath, mediaTypeFromExt);
  if (!src) return null;
  return imageBlockFromBase64(src.data, src.mediaType ?? 'image/png');
}

/** 历史图片文件无法在边界读时恢复时使用的安全占位文本(不包含原始路径)。 */
export const IMAGE_FILE_UNAVAILABLE_TEXT = '[image unavailable]';

/**
 * 历史图片没有异步 downscaler 注入点，因此沿用 current-turn 的 raw target 作为同步读盘硬闸。
 * 同时在读取前后检查 base64 API 上限，避免先无界 readFileSync 再把大文件膨胀到 wire。
 */
export const HISTORY_IMAGE_MAX_RAW_BYTES = IMAGE_TARGET_RAW_BYTES;

export interface ImageFileStat {
  size: number;
}

export type ImageFileStatReader = (path: string) => ImageFileStat;
export type ImageFileReader = (path: string, maxBytes: number) => Uint8Array | null;

function isWithinImageFileBudget(size: number): boolean {
  return (
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= HISTORY_IMAGE_MAX_RAW_BYTES &&
    base64LengthOfRaw(size) <= IMAGE_MAX_B64_BYTES
  );
}

/**
 * Host path reader shared by facade and Anthropic provider. It fstats the same open fd it reads,
 * allocates at most `maxBytes`, and always closes the fd. Callers pass raw-budget + 1 so a
 * growing/oversized file is observed and rejected before base64 conversion.
 */
export function readFilePathBounded(path: string, maxBytes: number): Uint8Array | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) return null;
    const target = Math.min(stat.size, maxBytes);
    const bytes = Buffer.allocUnsafe(target);
    let offset = 0;
    while (offset < target) {
      const count = readSync(fd, bytes, offset, target - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    return offset > 0 ? bytes.subarray(0, offset) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read result is already safely bounded; close errors must not leak path data.
      }
    }
  }
}

/**
 * 把 host-owned 历史中的 `image_file` block 读时转换为 provider 中立的 image block。
 *
 * 历史数据是旧格式，不能要求持久化层回写。`mimeType` / `mediaType` 和扩展名只作
 * 辅助信息，必须由支持格式的文件魔数确认后才建 image block；魔数失败、读盘失败或
 * 超出同步历史图片预算时交给调用方做文本降级。`statPath` 必须在 `readPath` 前执行。
 */
export function imageBlockFromFilePart(
  part: Record<string, unknown>,
  readPath: ImageFileReader,
  statPath: ImageFileStatReader,
): ImageContentBlock | null {
  if (part.type !== 'image_file') return null;
  const path = typeof part.path === 'string' ? part.path.trim() : '';
  if (!path) return null;

  try {
    // Check metadata before opening the file. The post-read check handles a file growing
    // between stat and read without ever turning an oversized buffer into base64.
    const stat = statPath(path);
    if (!isWithinImageFileBudget(stat.size)) return null;
    const bytes = readPath(path, HISTORY_IMAGE_MAX_RAW_BYTES + 1);
    if (!bytes || !isWithinImageFileBudget(bytes.length)) return null;
    const mediaType = imageMediaTypeFromMagic(bytes);
    if (!mediaType || !hasCompleteImageStructure(bytes, mediaType)) return null;
    return imageBlockFromBase64(bytesToBase64(bytes), mediaType);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * 递归规整消息 content 中的历史 `image_file` block。
 *
 * 只在发现旧 block 时创建新数组/对象，保持没有旧 block 的当前轮和既有 provider
 * 中立内容的引用/形状不变。`tool_result.content` 等嵌套 content 也必须规整，才能
 * 保证最终 Anthropic wire 中不残留 `image_file`。
 */
export function normalizeImageFileContent(
  content: unknown,
  readPath: ImageFileReader,
  statPath: ImageFileStatReader,
): unknown {
  if (isRecord(content) && content.type === 'image_file') {
    return imageBlockFromFilePart(content, readPath, statPath) ?? { type: 'text', text: IMAGE_FILE_UNAVAILABLE_TEXT };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const normalized = content.map((value) => {
      const next = normalizeImageFileContent(value, readPath, statPath);
      if (next !== value) changed = true;
      return next;
    });
    return changed ? normalized : content;
  }
  if (!isRecord(content)) return content;
  if (content.type === 'image') return content;

  // Only these fields carry host/model content. In particular, do not walk arbitrary record
  // values: tool_use.input, image.source, and opaque tool args may legitimately contain a
  // path-shaped/image_file-shaped value that must remain byte-for-byte unchanged.
  const contentKeys = content.type === 'tool_use' ? ['content'] : ['content', 'result', 'envelope'];
  let normalized: Record<string, unknown> | undefined;
  for (const key of contentKeys) {
    if (!Object.prototype.hasOwnProperty.call(content, key)) continue;
    const value = content[key];
    const next = normalizeImageFileContent(value, readPath, statPath);
    if (next !== value) {
      normalized ??= { ...content };
      normalized[key] = next;
    }
  }
  return normalized ?? content;
}

/** provider 中立 document content block(Anthropic PDF 形,`{type:'document',source:{...}}`)。 */
export interface DocumentContentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
}

/** 「用户输入附件」→ document block(kind:'document',目前即 PDF)。
 *  非 document / 无数据的项返回 null(forward-compat,调用方静默跳过)。 */
export function documentBlockFromAttachment(
  att: Record<string, unknown>,
  readPath: (path: string) => Uint8Array,
): DocumentContentBlock | null {
  if (att.kind !== 'document') return null;
  const src = base64FromAttachment(att, readPath);
  if (!src) return null;
  return { type: 'document', source: { type: 'base64', media_type: src.mediaType ?? 'application/pdf', data: src.data } };
}
