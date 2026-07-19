/**
 * Image downscale policy(移植 the reference agent CLI imageResizer 的策略常量与判定)—— 纯函数,无 IO。
 *
 * CC 的做法:图片**进 context 之前**先物理缩放 —— 尺寸钳进 2000×2000、原始字节目标
 * 3.75MB(= base64 5MB 硬限 × 3/4),从源头钳住单图成本;token 估算层(bytes-band)只是
 * 第二道防御。本文件只放**策略**(常量 / 尺寸嗅探 / 判定 / 注入类型);真正的缩放实现
 * 需要系统二进制(sips / ImageMagick),归 HOST 层(`cli/image-scale.ts`),经
 * `ToolContext.downscaleImage` / kernel option 注入(照 askQuestion / persistToolResult 先例)。
 *
 * 尺寸嗅探只读文件头(PNG IHDR / JPEG SOF / GIF header / WebP VP8*),不解码像素 ——
 * CC 的 catch 兜底同样靠读 PNG header 判尺寸。未识别格式 → null(fail-open,不拦)。
 *
 * Boundary: 机制层,零依赖、零 node: import。
 */

/** 客户端缩放的最长边(CC IMAGE_MAX_WIDTH/HEIGHT;API 内部 1568 就会再缩,客户端放宽保质量)。 */
export const IMAGE_MAX_EDGE = 2000;
/** API 单图 base64 硬限(CC API_IMAGE_MAX_BASE64_SIZE)。超限请求会被 provider 直接拒。 */
export const IMAGE_MAX_B64_BYTES = 5 * 1024 * 1024;
/** 原始字节目标(CC IMAGE_TARGET_RAW_SIZE;从 base64 硬限 × 3/4 派生,膨胀 4/3 后恰好不超限)。 */
export const IMAGE_TARGET_RAW_BYTES = Math.floor((IMAGE_MAX_B64_BYTES * 3) / 4);

/** raw 字节数 → base64 字符数(膨胀 4/3,4 字节对齐)。 */
export function base64LengthOfRaw(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export interface ImageDims {
  width: number;
  height: number;
}

/**
 * 从文件头嗅探图片像素尺寸(不解码)。支持 PNG / JPEG / GIF / WebP(VP8·VP8L·VP8X);
 * 未识别 / 头损坏 → null。
 */
export function sniffImageDims(bytes: Uint8Array): ImageDims | null {
  if (bytes.length < 12) return null;
  // PNG: 签名 8B + IHDR chunk(len4+type4)→ width u32BE@16, height u32BE@20
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  // JPEG: 扫段找 SOF0..SOF15(去掉 DHT C4 / JPG C8 / DAC CC)→ height u16BE@+5, width u16BE@+7
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) return null; // 段边界失配 → 头损坏
      const marker = bytes[off + 1];
      if (marker === 0xff) {
        off++; // 填充字节
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(bytes, off + 5), width: u16be(bytes, off + 7) };
      }
      off += 2 + u16be(bytes, off + 2); // 跳过本段(长度含自身 2B)
    }
    return null;
  }
  // GIF: "GIF8" → width u16LE@6, height u16LE@8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  // WebP: "RIFF"...."WEBP" + 首 chunk
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    if (bytes.length < 30) return null;
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      // canvas size:width-1 u24LE@24, height-1 u24LE@27
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    }
    if (chunk === 'VP8 ') {
      // lossy frame tag:width u14LE@26, height u14LE@28
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      // lossless:签名 0x2f@20,后 28 bits = (width-1)14 + (height-1)14
      if (bytes[20] !== 0x2f) return null;
      const b = u32le(bytes, 21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** 是否需要缩图:raw 超 3.75MB,或嗅探出的尺寸超 2000(嗅探不出时只看字节 —— fail-open)。 */
export function needsDownscale(bytes: Uint8Array): boolean {
  if (bytes.length > IMAGE_TARGET_RAW_BYTES) return true;
  const dims = sniffImageDims(bytes);
  return dims !== null && (dims.width > IMAGE_MAX_EDGE || dims.height > IMAGE_MAX_EDGE);
}

/**
 * 缩图实现的注入类型(HOST 提供,机制层可选消费):
 * bytes + mediaType → 缩放后的 bytes + mediaType(降质可能改格式,如 png→jpeg);
 * **null = 缩放器失败/不可用**,调用方走 degrade(≤5MB 原样透传,超限 loud 拒绝)。
 */
export type DownscaleImage = (
  bytes: Uint8Array,
  mediaType: string,
) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;

// ─── byte readers ─────────────────────────────────────────────────────────────

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
