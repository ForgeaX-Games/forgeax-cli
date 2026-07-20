/**
 * 共享图片缩放器(HOST 层)—— 系统二进制实现,零 npm 依赖(哲学对齐 sandbox-terminal E-03)。
 *
 * 策略归 core(`capability/image-scale-policy.ts`:2000×2000 / raw 3.75MB / b64 5MB,移植 CC);
 * 本文件只做**执行**:
 *   - darwin:`sips`(系统内建)—— 超尺寸 `sips -Z 2000`;仍超字节 → JPEG 质量阶梯
 *     [80,60,40,20](`-s format jpeg -s formatOptions <q>`,对齐 CC imageResizer 的降质阶梯)。
 *   - linux:`magick` / `convert`(ImageMagick,存在才用)—— `-resize 2000x2000> -quality <q>`。
 *   - 其它平台 / 二进制缺失:`makeImageDownscaler()` 返回 undefined,调用方 degrade
 *     (≤5MB 原样透传;超限在入口处 loud 拒绝 —— 不静默)。
 *
 * 流程 = 写临时文件 → 二进制 → 读回(照 imagePaste.ts 原 fitImageBuffer 写法;
 * execFileSync + timeout + try/catch,运行中任何失败返回 null 交调用方 degrade)。
 * 同步核心 `downscaleImageSync` 供 TUI 粘贴路径(本就同步)直用;异步 `DownscaleImage`
 * 形状经 `makeImageDownscaler()` 供 ToolContext / kernel option 注入。
 *
 * Boundary(HOST 层):node builtins + 相对 import。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_MAX_EDGE,
  IMAGE_TARGET_RAW_BYTES,
  needsDownscale,
  type DownscaleImage,
} from '../capability/image-scale-policy';

/** JPEG 降质阶梯(CC imageResizer 同款)。 */
const JPEG_QUALITY_LADDER = [80, 60, 40, 20] as const;
const EXEC_TIMEOUT_MS = 10_000;

function extForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* noop */
  }
}

/** darwin:sips 就地缩尺寸;仍超字节 → JPEG 阶梯另存降质。失败 → null。 */
function sipsDownscale(bytes: Uint8Array, mediaType: string): { bytes: Uint8Array; mediaType: string } | null {
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tmp = join(tmpdir(), `forgeax-scale-${stamp}.${extForMediaType(mediaType)}`);
  const tmpJpg = join(tmpdir(), `forgeax-scale-${stamp}.q.jpg`);
  try {
    writeFileSync(tmp, bytes);
    // 等比钳进 2000×2000(小于则 sips 不动,顺带规范化)。
    execFileSync('sips', ['-Z', String(IMAGE_MAX_EDGE), tmp], { timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' });
    let out = readFileSync(tmp);
    let outType = mediaType;
    if (out.length > IMAGE_TARGET_RAW_BYTES) {
      // 缩完仍超字节 → JPEG 质量阶梯(从已缩尺寸的图降质;PNG palette 量化 sips 不可得,
      // 直接走 JPEG —— 牺牲透明度仅发生在「不降就发不出去」时,与 CC 的最终降级一致)。
      for (const q of JPEG_QUALITY_LADDER) {
        try {
          execFileSync(
            'sips',
            ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), tmp, '--out', tmpJpg],
            { timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' },
          );
          const j = readFileSync(tmpJpg);
          if (j.length > 0 && j.length <= IMAGE_TARGET_RAW_BYTES) {
            out = j;
            outType = 'image/jpeg';
            break;
          }
        } catch {
          break; // jpeg 转换本身失败 → 用已缩尺寸的结果(交调用方 5MB 硬闸)
        }
      }
    }
    return out.length > 0 ? { bytes: out, mediaType: outType } : null;
  } catch {
    return null;
  } finally {
    safeUnlink(tmp);
    safeUnlink(tmpJpg);
  }
}

/** linux:ImageMagick(magick/convert)缩尺寸 + 必要时 JPEG 阶梯。失败 → null。 */
function magickDownscale(
  bin: string,
  bytes: Uint8Array,
  mediaType: string,
): { bytes: Uint8Array; mediaType: string } | null {
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ext = extForMediaType(mediaType);
  const tmpIn = join(tmpdir(), `forgeax-scale-${stamp}.${ext}`);
  const tmpOut = join(tmpdir(), `forgeax-scale-${stamp}.out.${ext}`);
  const tmpJpg = join(tmpdir(), `forgeax-scale-${stamp}.out.jpg`);
  const fit = `${IMAGE_MAX_EDGE}x${IMAGE_MAX_EDGE}>`; // `>` = 只缩不放大
  try {
    writeFileSync(tmpIn, bytes);
    execFileSync(bin, [tmpIn, '-resize', fit, tmpOut], { timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' });
    let out = readFileSync(tmpOut);
    let outType = mediaType;
    if (out.length > IMAGE_TARGET_RAW_BYTES) {
      for (const q of JPEG_QUALITY_LADDER) {
        try {
          execFileSync(bin, [tmpIn, '-resize', fit, '-quality', String(q), tmpJpg], {
            timeout: EXEC_TIMEOUT_MS,
            stdio: 'ignore',
          });
          const j = readFileSync(tmpJpg);
          if (j.length > 0 && j.length <= IMAGE_TARGET_RAW_BYTES) {
            out = j;
            outType = 'image/jpeg';
            break;
          }
        } catch {
          break;
        }
      }
    }
    return out.length > 0 ? { bytes: out, mediaType: outType } : null;
  } catch {
    return null;
  } finally {
    safeUnlink(tmpIn);
    safeUnlink(tmpOut);
    safeUnlink(tmpJpg);
  }
}

/** 二进制是否可用(照 sandbox-terminal.ts 的 `command -v` 先例)。 */
function binAvailable(name: string): boolean {
  try {
    return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * 同步缩图核心:不需要缩(策略判定)→ 原样返回;需要缩 → 平台实现;
 * 实现不可用/失败 → null(调用方 degrade)。TUI 粘贴路径(同步)直用。
 */
export function downscaleImageSync(
  bytes: Uint8Array,
  mediaType: string,
): { bytes: Uint8Array; mediaType: string } | null {
  if (!needsDownscale(bytes)) return { bytes, mediaType };
  if (process.platform === 'darwin') return sipsDownscale(bytes, mediaType);
  if (process.platform === 'linux') {
    const bin = binAvailable('magick') ? 'magick' : binAvailable('convert') ? 'convert' : null;
    return bin ? magickDownscale(bin, bytes, mediaType) : null;
  }
  return null; // windows 等:v1 无实现 → degrade
}

/**
 * 造注入用的异步缩图器。平台无可用实现 → undefined(调用方按「未注入」degrade;
 * 不在装配期刷 warn —— degrade 的可见性在入口处保证:read_file 回显式文案 / 附件换占位块)。
 */
export function makeImageDownscaler(): DownscaleImage | undefined {
  if (process.platform === 'darwin') {
    // sips 是 macOS 系统内建,直接可用。
  } else if (process.platform === 'linux') {
    if (!binAvailable('magick') && !binAvailable('convert')) return undefined;
  } else {
    return undefined;
  }
  return async (bytes, mediaType) => downscaleImageSync(bytes, mediaType);
}
