/**
 * 图片缩图(对齐 CC)—— policy(尺寸嗅探/判定)+ read_file/facade 接线 + darwin 真 sips。
 *
 * 覆盖:
 *   - sniffImageDims:PNG IHDR / JPEG SOF / GIF / WebP VP8X 头部嗅探(手工构造,零 fixture);
 *   - needsDownscale / base64LengthOfRaw 边界;
 *   - read_file:注入 fake downscaleImage → 被调且结果被用;无缩图器 + >5MB → loud 占位;
 *     无缩图器 + ≤5MB → 原样透传(degrade 不丢图);
 *   - facade:kernel option 注入 fake 缩图器 → 附件被缩;超限无缩图器 → 占位文本块;
 *   - darwin 门控(describe.if):真 sips 造 3000px 大图 → 共享缩图器缩进 2000×2000。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  sniffImageDims,
  needsDownscale,
  base64LengthOfRaw,
  IMAGE_MAX_EDGE,
  IMAGE_TARGET_RAW_BYTES,
  type DownscaleImage,
} from '../src/capability/image-scale-policy';
import { downscaleImageSync } from '../src/cli/image-scale';
import { readFileTool } from '../src/capability/builtin-tools/file-tools';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

// ─── 合成图片头(不解码像素,只需头部字段正确)────────────────────────────────

/** 合成 PNG 头(签名 + IHDR 宽高),尾部可垫任意字节撑体积。 */
function pngHeader(width: number, height: number, pad = 0): Uint8Array {
  const b = new Uint8Array(24 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** 合成 JPEG 头:SOI + APP0(16B)+ SOF0(带宽高)。 */
function jpegHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(2 + 18 + 10);
  let o = 0;
  b.set([0xff, 0xd8], o); o += 2; // SOI
  b.set([0xff, 0xe0, 0x00, 0x10], o); o += 4 + 14; // APP0 len=16(含自身 2B)+ 14B payload
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], o); // SOF0 len=17, precision 8
  const dv = new DataView(b.buffer);
  dv.setUint16(o + 5, height);
  dv.setUint16(o + 7, width);
  return b;
}

function gifHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  new DataView(b.buffer).setUint16(6, width, true);
  new DataView(b.buffer).setUint16(8, height, true);
  return b;
}

function webpVp8xHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]); // RIFF….WEBP
  b.set([0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00], 12); // 'VP8X' len=10
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ─── policy:sniff / needsDownscale ───────────────────────────────────────────

describe('image-scale-policy — sniffImageDims', () => {
  test('PNG IHDR', () => {
    expect(sniffImageDims(pngHeader(3000, 1200))).toEqual({ width: 3000, height: 1200 });
  });
  test('JPEG SOF0(跳过 APP0 段)', () => {
    expect(sniffImageDims(jpegHeader(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });
  test('GIF u16LE', () => {
    expect(sniffImageDims(gifHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });
  test('WebP VP8X canvas', () => {
    expect(sniffImageDims(webpVp8xHeader(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });
  test('真 1×1 PNG', () => {
    expect(sniffImageDims(new Uint8Array(Buffer.from(PNG_1x1_B64, 'base64')))).toEqual({ width: 1, height: 1 });
  });
  test('未识别格式 / 太短 → null(fail-open)', () => {
    expect(sniffImageDims(new TextEncoder().encode('plain text here'))).toBeNull();
    expect(sniffImageDims(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('image-scale-policy — needsDownscale / base64LengthOfRaw', () => {
  test('小尺寸小字节 → false', () => {
    expect(needsDownscale(pngHeader(800, 600, 1000))).toBe(false);
  });
  test(`尺寸超 ${IMAGE_MAX_EDGE} → true(字节很小也要缩)`, () => {
    expect(needsDownscale(pngHeader(3000, 100))).toBe(true);
    expect(needsDownscale(pngHeader(100, 2001))).toBe(true);
  });
  test('raw 超 3.75MB → true(嗅探不出尺寸也要缩)', () => {
    const big = new Uint8Array(IMAGE_TARGET_RAW_BYTES + 1);
    expect(needsDownscale(big)).toBe(true);
  });
  test('base64LengthOfRaw:膨胀 4/3 且 4 字节对齐', () => {
    expect(base64LengthOfRaw(3)).toBe(4);
    expect(base64LengthOfRaw(4)).toBe(8);
    expect(base64LengthOfRaw(3 * 1024 * 1024)).toBe(4 * 1024 * 1024);
  });
});

// ─── read_file 接线(fake scaler / degrade)────────────────────────────────────

class MemFs implements SandboxFs {
  bins = new Map<string, Uint8Array>();
  constructor(bins: Record<string, Uint8Array>) {
    for (const [k, v] of Object.entries(bins)) this.bins.set(k, v);
  }
  readTextSync(): string { throw new Error('not used'); }
  writeTextSync(): void {}
  mkdirSync(): void {}
  existsSync(path: string): boolean { return this.bins.has(path); }
  unlinkSync(): void {}
  renameSync(): void {}
  statSync(): StatResult { return { isFile: true, isDir: false, size: 0, mtime: 0 }; }
  readdirSync(): string[] | DirEnt[] { return []; }
  async readText(): Promise<string> { throw new Error('not used'); }
  async writeText(): Promise<void> {}
  async readBytes(path: string, offset = 0, limit?: number): Promise<Uint8Array> {
    const full = this.bins.get(path);
    if (!full) throw new Error(`ENOENT(bin) ${path}`);
    return full.slice(offset, limit !== undefined ? offset + limit : full.length);
  }
  async writeBytes(): Promise<void> {}
  readStream(): ReadableStream<Uint8Array> { throw new Error('not used'); }
  writeStream(): WritableStream<Uint8Array> { throw new Error('not used'); }
  async *readDir(): AsyncIterable<DirEnt> {}
}

function ctxWith(extra: Record<string, unknown>): ToolContext {
  return { signal: new AbortController().signal, ...extra };
}

describe('read_file — 进 context 前缩图接线', () => {
  const BIG_PNG = pngHeader(3000, 2000, 500); // 尺寸超限,字节很小

  test('注入 downscaleImage → 被调,结果(bytes+mediaType)进 image block', async () => {
    const calls: Array<{ len: number; mediaType: string }> = [];
    const scaled = jpegHeader(1500, 1000);
    const fake: DownscaleImage = async (bytes, mediaType) => {
      calls.push({ len: bytes.length, mediaType });
      return { bytes: scaled, mediaType: 'image/jpeg' };
    };
    const fs = new MemFs({ '/big.png': BIG_PNG });
    const { data } = await readFileTool().call(
      { file_path: '/big.png' },
      ctxWith({ sandboxFs: fs, downscaleImage: fake }),
    );
    expect(calls.length).toBe(1);
    expect(calls[0].mediaType).toBe('image/png');
    const block = data.imageBlocks![0];
    expect(block.source.media_type).toBe('image/jpeg');
    expect(block.source.data).toBe(Buffer.from(scaled).toString('base64'));
  });

  test('不需要缩(小图)→ 缩图器不被调,原样', async () => {
    let called = 0;
    const fake: DownscaleImage = async (bytes, mediaType) => {
      called++;
      return { bytes, mediaType };
    };
    const small = pngHeader(800, 600, 100);
    const fs = new MemFs({ '/small.png': small });
    const { data } = await readFileTool().call(
      { file_path: '/small.png' },
      ctxWith({ sandboxFs: fs, downscaleImage: fake }),
    );
    expect(called).toBe(0);
    expect(data.imageBlocks![0].source.data).toBe(Buffer.from(small).toString('base64'));
  });

  test('无缩图器 + base64 ≤5MB → 原样透传(degrade 不丢图)', async () => {
    const fs = new MemFs({ '/big.png': BIG_PNG });
    const { data } = await readFileTool().call({ file_path: '/big.png' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks![0].source.data).toBe(Buffer.from(BIG_PNG).toString('base64'));
  });

  test('无缩图器 + base64 >5MB → loud 占位,不带图(原样送出必被 API 拒)', async () => {
    const huge = pngHeader(3000, 3000, 4 * 1024 * 1024); // raw 4MB → b64 ~5.3MB
    const fs = new MemFs({ '/huge.png': huge });
    const { data } = await readFileTool().call({ file_path: '/huge.png' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeUndefined();
    expect(data.content).toContain('too large');
    expect(data.content).toContain('5MB');
  });

  test('缩图器失败(null)+ ≤5MB → 原样透传', async () => {
    const fake: DownscaleImage = async () => null;
    const fs = new MemFs({ '/big.png': BIG_PNG });
    const { data } = await readFileTool().call(
      { file_path: '/big.png' },
      ctxWith({ sandboxFs: fs, downscaleImage: fake }),
    );
    expect(data.imageBlocks![0].source.data).toBe(Buffer.from(BIG_PNG).toString('base64'));
  });
});

// ─── facade 附件接线(kernel option)───────────────────────────────────────────

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function capturing(): { provider: LLMProvider; calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(r: ProviderRequest) {
      calls.push(r);
      yield asstText('ok');
    },
  } as LLMProvider;
  return { provider, calls };
}
function turnReq(attachments: Array<Record<string, unknown>>): TurnRequest {
  return {
    session: { threadId: 'th', agentId: 'ag' },
    input: { text: 'look', attachments } as TurnRequest['input'],
    systemPrompt: { charter: 'C', persona: 'P' },
    tools: [],
    budget: { maxTurns: 4 },
  };
}
async function runKernel(k: ForgeaxCoreKernel, r: TurnRequest): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const e of k.runTurn(r, new AbortController().signal)) out.push(e);
  return out;
}
function firstUserContent(calls: ProviderRequest[]): Array<Record<string, unknown>> {
  const m = calls[0].messages.find((x) => x.role === 'user');
  return m!.content as Array<Record<string, unknown>>;
}

describe('facade 附件 — 进 context 前缩图(kernel option)', () => {
  const BIG_PNG_B64 = Buffer.from(pngHeader(3000, 2000, 500)).toString('base64');

  test('注入 downscaleImage → 超尺寸附件被缩(base64 换成缩后产物)', async () => {
    const scaled = jpegHeader(1500, 1000);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({
      provider,
      executeTool: async () => null,
      downscaleImage: async () => ({ bytes: scaled, mediaType: 'image/jpeg' }),
    });
    await runKernel(k, turnReq([{ kind: 'image', mediaType: 'image/png', data: BIG_PNG_B64 }]));
    const content = firstUserContent(calls);
    const src = (content[1] as { source: { media_type: string; data: string } }).source;
    expect(src.media_type).toBe('image/jpeg');
    expect(src.data).toBe(Buffer.from(scaled).toString('base64'));
  });

  test('无缩图器 + 超 5MB 附件 → 占位文本块(loud degrade)', async () => {
    const hugeB64 = Buffer.from(pngHeader(3000, 3000, 4 * 1024 * 1024)).toString('base64');
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await runKernel(k, turnReq([{ kind: 'image', mediaType: 'image/png', data: hugeB64 }]));
    const content = firstUserContent(calls);
    expect(content[1].type).toBe('text');
    expect(String(content[1].text)).toContain('dropped');
    expect(String(content[1].text)).toContain('5MB');
  });

  test('无缩图器 + ≤5MB 超尺寸附件 → 原样透传(旧行为)', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await runKernel(k, turnReq([{ kind: 'image', mediaType: 'image/png', data: BIG_PNG_B64 }]));
    const content = firstUserContent(calls);
    const src = (content[1] as { source: { data: string } }).source;
    expect(src.data).toBe(BIG_PNG_B64);
  });

  test('小附件 → 缩图器不被调,零回归', async () => {
    let called = 0;
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({
      provider,
      executeTool: async () => null,
      downscaleImage: async (bytes, mediaType) => {
        called++;
        return { bytes, mediaType };
      },
    });
    await runKernel(k, turnReq([{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }]));
    expect(called).toBe(0);
    const src = (firstUserContent(calls)[1] as { source: { data: string } }).source;
    expect(src.data).toBe('QUJD');
  });
});

// ─── darwin 真 sips(共享缩图器端到端)────────────────────────────────────────

const isMac = process.platform === 'darwin';

describe.if(isMac)('downscaleImageSync — 真 sips(darwin)', () => {
  test('3000px 大 PNG → 缩进 2000×2000 且 raw ≤3.75MB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-scale-'));
    const p = join(dir, 'big.png');
    writeFileSync(p, Buffer.from(PNG_1x1_B64, 'base64'));
    // 照 paste-image-e2e L4b:用 sips 把 1×1 上采样成 3000×2200 大图。
    execFileSync('sips', ['-z', '2200', '3000', p], { timeout: 10_000, stdio: 'ignore' });
    const big = new Uint8Array(readFileSync(p));
    expect(sniffImageDims(big)).toEqual({ width: 3000, height: 2200 });
    expect(needsDownscale(big)).toBe(true);

    const out = downscaleImageSync(big, 'image/png');
    expect(out).not.toBeNull();
    const dims = sniffImageDims(out!.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
    expect(out!.bytes.length).toBeLessThanOrEqual(IMAGE_TARGET_RAW_BYTES);
  });

  test('小图 → 原样返回(零改写)', () => {
    const small = new Uint8Array(Buffer.from(PNG_1x1_B64, 'base64'));
    const out = downscaleImageSync(small, 'image/png');
    expect(out).not.toBeNull();
    expect(out!.bytes).toBe(small); // needsDownscale=false → 原引用透传
  });
});
