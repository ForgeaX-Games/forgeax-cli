/** content-utils —— ContentPart 相关的二进制嗅探与文件→Part 转换。
 *
 *  ContentPart 类型守卫（isMediaContentPart 等）已经在 core/types.ts 内置，本文件
 *  不重复导出，只放：
 *  - isBinaryBuffer / isBinaryFile：扫前 8KB 看有没有 0x00，决定走 text_file 还是
 *    image/audio/video/file。
 *  - fileToContentPart：根据 mimeType + binary 探测结果给出 ContentPart 变体。 */

import type { ContentPart } from "../core/types";

const BINARY_PROBE_SIZE = 8192;

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_PROBE_SIZE);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function isBinaryFile(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const fd = await open(path, "r");
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
  // binary 探测优先：.ts → "video/mp2t" 这类 mime 误判由探测兜底。
  if (binary === false) return { type: "text_file", path, mimeType };
  if (mimeType.startsWith("image/")) return { type: "image_file", path, mimeType };
  if (mimeType.startsWith("audio/")) return { type: "audio_file", path, mimeType };
  if (mimeType.startsWith("video/")) return { type: "video_file", path, mimeType };
  return { type: "file", path, mimeType };
}
