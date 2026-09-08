/**
 * 011 · 多模态 read_file(图片 / PDF)单测。
 *
 * 用内存 stub 的 SandboxFs(支持 readBytes)测:
 *   - PNG/JPEG(扩展名 + 魔数)→ read_file 返回 image content block(base64 + mediaType);
 *   - 无扩展名但文件头是 PNG → 仍判图片(magic-bytes 兜底);
 *   - 文本文件 → 走原文本路径不回归;
 *   - mapResult 把 imageBlocks 透到 tool.result payload;
 *   - 共享 helper(image-block.ts)各函数;
 *   - facade 用的 imageBlockFromAttachment 经共享 helper 仍可建块。
 * 不打真 IO。风格对齐 test/builtin-tools.test.ts。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import { readFileTool } from '../src/capability/builtin-tools/file-tools';
import {
  mediaTypeFromExt,
  isImageExt,
  imageMediaTypeFromMagic,
  bytesToBase64,
  imageBlockFromBase64,
  imageBlockFromBytes,
  parseDataUrl,
  imageBlockFromAttachment,
  imageBlockFromFilePart,
  normalizeImageFileContent,
  IMAGE_FILE_UNAVAILABLE_TEXT,
  HISTORY_IMAGE_MAX_RAW_BYTES,
  readFilePathBounded,
} from '../src/capability/image-block';

// ─── 测试用图片字节(合法文件头魔数) ────────────────────────────────────────────

// 真实的 1x1 fixtures，而不是“签名 + 任意 junk”；历史 path-backed image 必须至少通过
// 支持格式的魔数识别，伪 MIME/截断字节不能被包装成 image block。
const PNG_MAGIC = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));
const JPEG_MAGIC = new Uint8Array(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
));
const GIF_MAGIC = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
// cwebp 1x1 lossless output. The previous constant declared a 42-byte RIFF but contained
// only 36 bytes, so it was itself a truncated file rather than a complete WebP fixture.
const WEBP_MAGIC = new Uint8Array(Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAEAfQm9a3pZiBiOh/AAA=', 'base64'));

// ─── stub SandboxFs(内存 bytes 树,支持 readBytes) ─────────────────────────────

class MemFs implements SandboxFs {
  texts = new Map<string, string>();
  bins = new Map<string, Uint8Array>();

  constructor(opts: { texts?: Record<string, string>; bins?: Record<string, Uint8Array> } = {}) {
    for (const [k, v] of Object.entries(opts.texts ?? {})) this.texts.set(k, v);
    for (const [k, v] of Object.entries(opts.bins ?? {})) this.bins.set(k, v);
  }

  readTextSync(path: string): string {
    const v = this.texts.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  writeTextSync(path: string, content: string): void {
    this.texts.set(path, content);
  }
  mkdirSync(): void {}
  existsSync(path: string): boolean {
    return this.texts.has(path) || this.bins.has(path);
  }
  unlinkSync(path: string): void {
    this.texts.delete(path);
    this.bins.delete(path);
  }
  renameSync(): void {}
  statSync(path: string): StatResult {
    return { isFile: this.existsSync(path), isDir: false, size: 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async *readDir(): AsyncIterable<DirEnt> {}
  async readText(path: string): Promise<string> {
    return this.readTextSync(path);
  }
  async writeText(path: string, content: string): Promise<void> {
    this.writeTextSync(path, content);
  }
  async readBytes(path: string, offset = 0, limit?: number): Promise<Uint8Array> {
    const full = this.bins.get(path);
    if (!full) throw new Error(`ENOENT(bin) ${path}`);
    const end = limit !== undefined ? offset + limit : full.length;
    return full.slice(offset, end);
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.bins.set(path, data);
  }
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('not used');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('not used');
  }
}

function ctxWith(extra: Record<string, unknown>): ToolContext {
  return { signal: new AbortController().signal, ...extra };
}

// ─── 共享 helper: image-block.ts ─────────────────────────────────────────────

describe('image-block helper', () => {
  test('mediaTypeFromExt maps known exts, falls back to png', () => {
    expect(mediaTypeFromExt('/a.png')).toBe('image/png');
    expect(mediaTypeFromExt('/a.JPG')).toBe('image/jpeg');
    expect(mediaTypeFromExt('/a.jpeg')).toBe('image/jpeg');
    expect(mediaTypeFromExt('/a.gif')).toBe('image/gif');
    expect(mediaTypeFromExt('/a.webp')).toBe('image/webp');
    expect(mediaTypeFromExt('/a.unknown')).toBe('image/png');
  });

  test('isImageExt only true for image exts', () => {
    expect(isImageExt('/a.png')).toBe(true);
    expect(isImageExt('/a.JPEG')).toBe(true);
    expect(isImageExt('/a.txt')).toBe(false);
    expect(isImageExt('/a')).toBe(false);
  });

  test('imageMediaTypeFromMagic detects png/jpeg/gif/webp, null otherwise', () => {
    expect(imageMediaTypeFromMagic(PNG_MAGIC)).toBe('image/png');
    expect(imageMediaTypeFromMagic(JPEG_MAGIC)).toBe('image/jpeg');
    expect(imageMediaTypeFromMagic(GIF_MAGIC)).toBe('image/gif');
    expect(imageMediaTypeFromMagic(WEBP_MAGIC)).toBe('image/webp');
    expect(imageMediaTypeFromMagic(new TextEncoder().encode('hello world plain text'))).toBeNull();
    expect(imageMediaTypeFromMagic(new Uint8Array([1, 2, 3]))).toBeNull(); // 太短
  });

  test('bytesToBase64 round-trips', () => {
    const b64 = bytesToBase64(PNG_MAGIC);
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(PNG_MAGIC));
  });

  test('imageBlockFromBase64 builds anthropic image block', () => {
    const block = imageBlockFromBase64('AAAA', 'image/png');
    expect(block.type).toBe('image');
    expect(block.source.type).toBe('base64');
    expect(block.source.media_type).toBe('image/png');
    expect(block.source.data).toBe('AAAA');
  });

  test('imageBlockFromBytes prefers magic-bytes over ext', () => {
    // 字节是 JPEG,但路径扩展名 .png → 应以魔数 JPEG 为准。
    const block = imageBlockFromBytes(JPEG_MAGIC, '/wrong.png');
    expect(block.source.media_type).toBe('image/jpeg');
  });

  test('parseDataUrl extracts data + mediaType', () => {
    const r = parseDataUrl('data:image/png;base64,QUJD');
    expect(r).not.toBeNull();
    expect(r!.data).toBe('QUJD');
    expect(r!.mediaType).toBe('image/png');
    expect(parseDataUrl('not-a-data-url')).toBeNull();
  });

  test('imageBlockFromAttachment: base64 data', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', data: 'QUJD', mediaType: 'image/png' },
      () => new Uint8Array(),
    );
    expect(block?.source.data).toBe('QUJD');
    expect(block?.source.media_type).toBe('image/png');
  });

  test('imageBlockFromAttachment: dataUrl prefix tolerated', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', data: 'data:image/jpeg;base64,QUJD' },
      () => new Uint8Array(),
    );
    expect(block?.source.media_type).toBe('image/jpeg');
    expect(block?.source.data).toBe('QUJD');
  });

  test('imageBlockFromAttachment: path → readPath injection', () => {
    const block = imageBlockFromAttachment({ kind: 'image', path: '/x.png' }, () => PNG_MAGIC);
    expect(block?.source.media_type).toBe('image/png');
    expect(block?.source.data).toBe(bytesToBase64(PNG_MAGIC));
  });

  test('imageBlockFromAttachment: non-image kind → null', () => {
    expect(imageBlockFromAttachment({ kind: 'file', path: '/x.txt' }, () => new Uint8Array())).toBeNull();
  });

  test('imageBlockFromAttachment: path read failure → null (graceful)', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', path: '/missing.png' },
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(block).toBeNull();
  });

  test('imageBlockFromFilePart: image_file path + mimeType → canonical image block', () => {
    const block = imageBlockFromFilePart(
      { type: 'image_file', path: '/history.png', mimeType: 'image/png' },
      () => PNG_MAGIC,
      () => ({ size: PNG_MAGIC.length }),
    );
    expect(block).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(PNG_MAGIC) },
    });
  });

  test('imageBlockFromFilePart accepts structurally complete real 1x1 fixtures for all formats', () => {
    const fixtures = [
      ['png', 'image/png', PNG_MAGIC],
      ['jpg', 'image/jpeg', JPEG_MAGIC],
      ['gif', 'image/gif', GIF_MAGIC],
      ['webp', 'image/webp', WEBP_MAGIC],
    ] as const;
    for (const [extension, mediaType, bytes] of fixtures) {
      const block = imageBlockFromFilePart(
        { type: 'image_file', path: `/real.${extension}`, mimeType: mediaType },
        () => bytes,
        () => ({ size: bytes.length }),
      );
      expect(block?.source.media_type).toBe(mediaType);
      expect(block?.source.data).toBe(bytesToBase64(bytes));
    }
  });

  test('imageBlockFromFilePart rejects every proper prefix of each real fixture', () => {
    const fixtures = [
      ['png', 'image/png', PNG_MAGIC],
      ['jpg', 'image/jpeg', JPEG_MAGIC],
      ['gif', 'image/gif', GIF_MAGIC],
      ['webp', 'image/webp', WEBP_MAGIC],
    ] as const;
    for (const [extension, mediaType, bytes] of fixtures) {
      const acceptedPrefixLengths: number[] = [];
      for (let length = 1; length < bytes.length; length++) {
        const prefix = bytes.slice(0, length);
        const block = imageBlockFromFilePart(
          { type: 'image_file', path: `/prefix.${extension}`, mimeType: mediaType },
          () => prefix,
          () => ({ size: prefix.length }),
        );
        if (block !== null) acceptedPrefixLengths.push(length);
      }
      expect(acceptedPrefixLengths).toEqual([]);

      const complete = imageBlockFromFilePart(
        { type: 'image_file', path: `/complete.${extension}`, mimeType: mediaType },
        () => bytes,
        () => ({ size: bytes.length }),
      );
      expect(complete?.source.media_type).toBe(mediaType);
    }
  });

  test('normalizeImageFileContent: missing or non-image image_file → safe placeholder', () => {
    const normalized = normalizeImageFileContent(
      [
        { type: 'image_file', path: '/missing.png', mimeType: 'image/png' },
        { type: 'tool_result', content: [{ type: 'image_file', path: '/note.txt', mimeType: 'text/plain' }] },
      ],
      () => {
        throw new Error('ENOENT');
      },
      () => ({ size: 1 }),
    ) as Array<Record<string, unknown>>;
    expect(normalized[0]).toEqual({ type: 'text', text: IMAGE_FILE_UNAVAILABLE_TEXT });
    expect((normalized[1].content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'text',
      text: IMAGE_FILE_UNAVAILABLE_TEXT,
    });
    expect(JSON.stringify(normalized)).not.toContain('image_file');
  });

  test('image magic uses each format minimum signature length and rejects truncation', () => {
    expect(imageMediaTypeFromMagic(PNG_MAGIC.slice(0, 8))).toBe('image/png');
    expect(imageMediaTypeFromMagic(JPEG_MAGIC.slice(0, 3))).toBe('image/jpeg');
    expect(imageMediaTypeFromMagic(GIF_MAGIC.slice(0, 6))).toBe('image/gif');
    expect(imageMediaTypeFromMagic(WEBP_MAGIC.slice(0, 12))).toBe('image/webp');
    expect(imageMediaTypeFromMagic(PNG_MAGIC.slice(0, 7))).toBeNull();
    expect(imageMediaTypeFromMagic(JPEG_MAGIC.slice(0, 2))).toBeNull();
    expect(imageMediaTypeFromMagic(GIF_MAGIC.slice(0, 5))).toBeNull();
    expect(imageMediaTypeFromMagic(WEBP_MAGIC.slice(0, 11))).toBeNull();
  });

  test('path-backed history image requires magic, handles MIME conflict, and stats before read', () => {
    const text = new TextEncoder().encode('plain text that is not a png');
    expect(
      imageBlockFromFilePart(
        { type: 'image_file', path: '/pretend.png', mimeType: 'image/png' },
        () => text,
        () => ({ size: text.length }),
      ),
    ).toBeNull();

    const truncated = [
      ['/truncated.png', PNG_MAGIC.slice(0, 32)],
      ['/truncated.jpg', JPEG_MAGIC.slice(0, 20)],
      ['/truncated.gif', GIF_MAGIC.slice(0, 6)],
      ['/truncated.webp', WEBP_MAGIC.slice(0, 19)],
    ] as const;
    for (const [path, bytes] of truncated) {
      expect(
        imageBlockFromFilePart(
          { type: 'image_file', path, mimeType: 'image/png' },
          () => bytes,
          () => ({ size: bytes.length }),
        ),
      ).toBeNull();
    }

    const order: string[] = [];
    const block = imageBlockFromFilePart(
      { type: 'image_file', path: '/conflict.jpg', mimeType: 'image/jpeg' },
      () => {
        order.push('read');
        return PNG_MAGIC;
      },
      () => {
        order.push('stat');
        return { size: PNG_MAGIC.length };
      },
    );
    expect(order).toEqual(['stat', 'read']);
    expect(block?.source.media_type).toBe('image/png');
  });

  test('bounded reader uses one fd and never returns more than its explicit limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-bounded-image-'));
    const path = join(dir, 'growing.bin');
    writeFileSync(path, Buffer.alloc(64, 0x61));
    const bytes = readFilePathBounded(path, 8);
    expect(bytes?.length).toBe(8);
  });

  test('stat-small/read-growing path is bounded at raw budget + 1 before rejection', () => {
    let requestedMax = 0;
    const block = imageBlockFromFilePart(
      { type: 'image_file', path: '/growing.png', mimeType: 'image/png' },
      (_path, maxBytes) => {
        requestedMax = maxBytes;
        const bytes = new Uint8Array(maxBytes);
        bytes.set(PNG_MAGIC);
        return bytes;
      },
      () => ({ size: PNG_MAGIC.length }),
    );
    expect(block).toBeNull();
    expect(requestedMax).toBe(HISTORY_IMAGE_MAX_RAW_BYTES + 1);
  });

  test('oversized history image is dropped before read and never base64 encoded', () => {
    let reads = 0;
    const block = imageBlockFromFilePart(
      { type: 'image_file', path: '/too-large.png', mimeType: 'image/png' },
      () => {
        reads++;
        return PNG_MAGIC;
      },
      () => ({ size: HISTORY_IMAGE_MAX_RAW_BYTES + 1 }),
    );
    expect(block).toBeNull();
    expect(reads).toBe(0);
  });

  test('normalizeImageFileContent walks object envelopes and nested result/content arrays', () => {
    const normalized = normalizeImageFileContent(
      {
        type: 'tool_result',
        result: {
          envelope: {
            content: {
              content: [{ type: 'text', text: 'before' }, { type: 'image_file', path: '/nested.png', mimeType: 'image/png' }],
            },
          },
        },
      },
      () => PNG_MAGIC,
      () => ({ size: PNG_MAGIC.length }),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain('image_file');
    expect(serialized).not.toContain('/nested.png');
    expect(serialized).toContain('"type":"image"');
  });

  test('tool_use.input is opaque, while tool_use.content still normalizes', () => {
    const opaqueInput = {
      nested: { type: 'image_file', path: '/opaque-input.png', mimeType: 'image/png' },
      path: '/opaque-input.png',
    };
    const normalized = normalizeImageFileContent(
      [{
        type: 'tool_use',
        id: 'opaque-1',
        name: 'inspect',
        input: opaqueInput,
        content: [{ type: 'image_file', path: '/content.png', mimeType: 'image/png' }],
      }],
      (path) => {
        if (path === '/opaque-input.png') throw new Error('opaque input must not be read');
        return PNG_MAGIC;
      },
      (path) => {
        if (path === '/opaque-input.png') throw new Error('opaque input must not be stat-ed');
        return { size: PNG_MAGIC.length };
      },
    ) as Array<Record<string, unknown>>;
    expect(normalized[0].input).toEqual(opaqueInput);
    expect((normalized[0].content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(PNG_MAGIC) },
    });
  });
});

// ─── read_file 多模态分支 ─────────────────────────────────────────────────────

describe('read_file multimodal', () => {
  test('PNG (by ext) → returns image content block, not text', async () => {
    const fs = new MemFs({ bins: { '/shot.png': PNG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/shot.png' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks!.length).toBe(1);
    const block = data.imageBlocks![0];
    expect(block.type).toBe('image');
    expect(block.source.media_type).toBe('image/png');
    expect(block.source.data).toBe(bytesToBase64(PNG_MAGIC));
    // 文本 content 是人类可读占位,不是图片字节。
    expect(data.content).toContain('image');
    expect(data.numLines).toBe(0);
  });

  test('JPEG (by ext) → image block with image/jpeg', async () => {
    const fs = new MemFs({ bins: { '/photo.jpg': JPEG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/photo.jpg' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks![0].source.media_type).toBe('image/jpeg');
  });

  test('no extension but PNG magic bytes → detected as image', async () => {
    const fs = new MemFs({ bins: { '/blob': PNG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/blob' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks![0].source.media_type).toBe('image/png');
  });

  test('text file → text path unchanged (no imageBlocks, line numbers)', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'l1\nl2\nl3' } });
    const { data } = await readFileTool().call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeUndefined();
    expect(data.totalLines).toBe(3);
    expect(data.numLines).toBe(3);
    expect(data.content).toContain('1\tl1');
    expect(data.content).toContain('3\tl3');
  });

  test('text file with no extension (not image magic) → text path', async () => {
    // bins 没有该 path → readBytes 抛错 → tryReadImage 回落 null → 文本路径读到。
    const fs = new MemFs({ texts: { '/README': 'plain readme line' } });
    const { data } = await readFileTool().call({ file_path: '/README' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeUndefined();
    expect(data.content).toContain('plain readme line');
  });

  test('text path still honors offset + limit (no regression)', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'l1\nl2\nl3\nl4' } });
    const { data } = await readFileTool().call(
      { file_path: '/a.txt', offset: 2, limit: 2 },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.numLines).toBe(2);
    expect(data.content).toContain('2\tl2');
    expect(data.content).toContain('3\tl3');
    expect(data.content).not.toContain('l1');
  });

  test('mapResult carries imageBlocks into tool.result payload for image', async () => {
    const fs = new MemFs({ bins: { '/shot.png': PNG_MAGIC } });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/shot.png' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_img');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.toolUseId).toBe('tu_img');
    const blocks = payload.imageBlocks as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as { type: string }).type).toBe('image');
  });

  test('mapResult for text result has no imageBlocks key', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'hi' } });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_txt');
    expect((ev.payload as Record<string, unknown>).imageBlocks).toBeUndefined();
  });

  test('predicates unchanged: read-only + concurrency-safe + maxResultSizeChars bounded (C-01)', () => {
    const t = readFileTool();
    expect(t.isReadOnly({ file_path: '/a' })).toBe(true);
    expect(t.isConcurrencySafe({ file_path: '/a' })).toBe(true);
    expect(Number.isFinite(t.maxResultSizeChars)).toBe(true);
  });

  test('inputJSONSchema exposes pages param (PDF forward-compat)', () => {
    const schema = readFileTool().inputJSONSchema as { properties: Record<string, unknown> };
    expect(schema.properties.pages).toBeDefined();
  });
});
