/**
 * input/imagePaste.ts —— 粘贴/拖入图片的读取与多模态封装(层4 + 承载封装)。
 *
 * §0 根因(见 docs/paste-image-alignment.md):终端**不会把图片二进制流给应用**。Cmd+V
 * 一张剪贴板图片时,终端只发一个**空的 bracketed paste**(ESC[200~ESC[201~,中间无内容),
 * 不带任何图片数据。正确姿态是:normalize 保留「空粘贴」信号(paste-image-probe)→ 以它为
 * 触发**主动去读系统剪贴板** → 转 base64 → 走多模态 content block 送模型。
 *
 * 本文件提供三件事:
 *   1) readClipboardImage()   —— 读系统剪贴板里的图片(macOS 主路径 osascript;Linux/Win 回退)。
 *   2) readImageFile(path)    —— 拖入/Finder 的图片文件路径 → base64(拖文件常以「路径文本」到达)。
 *   3) buildUserContent(...)  —— text + images → Anthropic **中立** content block 数组
 *      (`{type:'image', source:{type:'base64', media_type, data}}`),这正是本仓所有 provider
 *      (anthropic 透传 / openai-compat / gemini / openai-response 翻译)消费的形状。
 *
 * Boundary(HOST 层):仅 node builtins + 相对 import(type-only 引 contracts)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageAttachment } from '../contracts';
import { IMAGE_MAX_B64_BYTES } from '../../capability/image-scale-policy';
import { downscaleImageSync } from '../../cli/image-scale';

/** 支持的图片扩展名(拖入路径识别 + 扩展名兜底 mediaType)。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Anthropic 单图上限:base64 载荷 5MB。超限请求会被 provider 直接拒。
 *  (SSOT 收编到 capability/image-scale-policy;此处保留原导出名供既有消费方。) */
export const MAX_IMAGE_B64_BYTES = IMAGE_MAX_B64_BYTES;

/** 图片 base64 的字节数(= 载荷大小,用于 5MB 判定)。 */
export function imageB64Bytes(img: ImageAttachment): number {
  return Buffer.byteLength(img.data, 'utf8');
}

/** 是否在 API 单图上限内。 */
export function isWithinImageLimit(img: ImageAttachment): boolean {
  return imageB64Bytes(img) <= MAX_IMAGE_B64_BYTES;
}

/**
 * 把一段图片 buffer 收进 API 上限内 —— 委托共享缩图器(`cli/image-scale.ts`,
 * 策略对齐 CC:2000×2000 / raw 3.75MB;darwin sips / linux ImageMagick)。
 * 缩图器不可用/失败 → 原样返回(由调用方的 5MB 硬闸决定收/弃)。
 */
function fitImageBuffer(buf: Buffer): Buffer {
  const scaled = downscaleImageSync(buf, mediaTypeFromMagic(buf) ?? 'image/png');
  return scaled && scaled.bytes.length > 0 ? Buffer.from(scaled.bytes) : buf;
}

/**
 * text + images → provider 中立消息 content。
 *   - 无图 → 原字符串(多数场景最省,provider 直用)。
 *   - 有图 → `[{type:'text',text}?, {type:'image',source:{type:'base64',media_type,data}}...]`
 *     (Anthropic 原生形;openai-compat/gemini/openai-response 均按 source.type==='base64'
 *      + source.data + source.media_type 翻译,见各 provider)。
 * 返回 `unknown` 以对齐 ProviderMessage.content(string | ContentBlock[])。
 */
export function buildUserContent(text: string, images?: ImageAttachment[]): unknown {
  if (!images || images.length === 0) return text;
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const img of images) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  return blocks;
}

/** 由 magic bytes 判 mediaType(比扩展名可靠;剪贴板/WSL 可能给 BMP)。未识别 → null。 */
export function mediaTypeFromMagic(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/** 由扩展名兜底 mediaType(magic 未命中时用)。未识别 → null。 */
function mediaTypeFromExt(path: string): string | null {
  const m = IMAGE_EXT.exec(path);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return `image/${ext}`;
}

/** 去掉路径两端引号/空白(拖入路径常被 shell 加引号或转义)。 */
function cleanPath(raw: string): string {
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\ /g, ' ');
}

/** 一个 token 是否「看起来是本机上存在的图片文件」。用于把拖入的路径文本与普通文本粘贴区分。 */
export function looksLikeImagePath(raw: string): boolean {
  const p = cleanPath(raw);
  if (!IMAGE_EXT.test(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 读图片文件 → base64。失败(不存在/空/非图片)→ null,绝不抛。 */
export function readImageFile(raw: string): ImageAttachment | null {
  try {
    const orig = readFileSync(cleanPath(raw));
    if (orig.length === 0) return null;
    const mediaType = mediaTypeFromMagic(orig) ?? mediaTypeFromExt(raw);
    if (!mediaType) return null;
    // 超限才缩(共享缩图器,长边钳到 IMAGE_MAX_EDGE / raw 目标;策略见 image-scale-policy),
    //   与剪贴板路径一致。缩放后按 magic 重判类型(缩图器可能把 WEBP/GIF 等改写为 PNG/JPEG)。
    const buf = fitImageBuffer(orig);
    return { data: buf.toString('base64'), mediaType: mediaTypeFromMagic(buf) ?? mediaType };
  } catch {
    return null;
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* noop */
  }
}

/** macOS:osascript 把剪贴板 «class PNGf» 写临时 PNG → 读回。无图 / 失败 → null。 */
function readClipboardImageMac(): ImageAttachment | null {
  const tmp = join(tmpdir(), `forgeax-clip-${process.pid}-${Date.now()}.png`);
  // «class PNGf» = 剪贴板里的 PNG flavor;无图时 `the clipboard as …` 抛错 → 返回 "noimg"。
  const lines = [
    'try',
    '  set imgData to (the clipboard as «class PNGf»)',
    `  set fileRef to (open for access (POSIX file "${tmp}") with write permission)`,
    '  write imgData to fileRef',
    '  close access fileRef',
    '  return "ok"',
    'on error',
    `  try`,
    `    close access (POSIX file "${tmp}")`,
    '  end try',
    '  return "noimg"',
    'end try',
  ];
  const args: string[] = [];
  for (const l of lines) args.push('-e', l);
  let out = '';
  try {
    out = execFileSync('osascript', args, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    safeUnlink(tmp);
    return null;
  }
  if (out !== 'ok') {
    safeUnlink(tmp);
    return null;
  }
  // 大图收进 API 上限内(共享缩图器;失败原样,交调用方 5MB 硬闸)。
  try {
    const buf = fitImageBuffer(readFileSync(tmp));
    if (buf.length === 0) return null;
    return { data: buf.toString('base64'), mediaType: mediaTypeFromMagic(buf) ?? 'image/png' };
  } catch {
    return null;
  } finally {
    safeUnlink(tmp);
  }
}

/** 读命令 stdout 为 Buffer;命令不存在 / 非零退出 / 空输出 → null。 */
function tryCmdBuffer(cmd: string, args: string[]): Buffer | null {
  try {
    const buf = execFileSync(cmd, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Linux:先 xclip(X11)后 wl-paste(Wayland)。 */
function readClipboardImageLinux(): ImageAttachment | null {
  const buf =
    tryCmdBuffer('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']) ??
    tryCmdBuffer('wl-paste', ['--type', 'image/png']);
  if (!buf) return null;
  return { data: buf.toString('base64'), mediaType: mediaTypeFromMagic(buf) ?? 'image/png' };
}

/** Windows:powershell 把剪贴板 Image 存临时 PNG → 读回。 */
function readClipboardImageWin(): ImageAttachment | null {
  const tmp = join(tmpdir(), `forgeax-clip-${process.pid}-${Date.now()}.png`);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $img=[System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${tmp.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'noimg' }`;
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000 }).trim();
  } catch {
    safeUnlink(tmp);
    return null;
  }
  if (out !== 'ok') {
    safeUnlink(tmp);
    return null;
  }
  try {
    const buf = readFileSync(tmp);
    if (buf.length === 0) return null;
    return { data: buf.toString('base64'), mediaType: mediaTypeFromMagic(buf) ?? 'image/png' };
  } catch {
    return null;
  } finally {
    safeUnlink(tmp);
  }
}

/**
 * 读系统剪贴板里的图片 → base64(按平台分派)。无图 / 不支持 / 失败 → null(绝不抛)。
 * 同步实现(execFileSync);调用方用 Promise 包一层放到微任务,避免阻塞按键回调。
 */
export function readClipboardImageSync(): ImageAttachment | null {
  switch (process.platform) {
    case 'darwin':
      return readClipboardImageMac();
    case 'linux':
      return readClipboardImageLinux();
    case 'win32':
      return readClipboardImageWin();
    default:
      return null;
  }
}

/** 异步壳:把同步读放到微任务,契合 Repl 的 async 探测流程。 */
export function readClipboardImage(): Promise<ImageAttachment | null> {
  return Promise.resolve().then(() => readClipboardImageSync());
}
