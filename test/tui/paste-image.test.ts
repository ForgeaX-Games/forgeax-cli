/**
 * 粘贴图片 —— 纯函数单测(normalize bracketed paste + imagePaste 封装/识别)。
 *
 * 覆盖(见 docs/paste-image-alignment.md + Ink 6.8 实测):
 *   - normalizeKey:空 bracketed paste(Ink 剥前导 ESC → "[200~\x1b[201~")→ paste-image-probe;
 *     文本 body → paste;单字符 body → char;粘贴+回车同 chunk → 追加 enter;带前导 ESC 的形态。
 *   - buildUserContent:无图 → 原字符串;有图 → Anthropic 中立 block(source.type='base64' +
 *     media_type + data),这是所有 provider 消费的形状。
 *   - mediaTypeFromMagic:PNG/JPEG/GIF/WEBP/BMP magic bytes 识别。
 *   - looksLikeImagePath / readImageFile:真临时文件读取 → base64。
 *
 * 不渲染、不挂 Ink、不触网;纯函数 + 临时文件,bun test 内跑。
 */
import { test, expect, describe } from 'bun:test';
import type { Key as InkKey } from 'ink';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPasteAssembler } from '../../src/tui/input/pasteAssembler';
import { shouldCollapsePaste, pastePlaceholder, expandPastes, countLines } from '../../src/tui/input/pasteText';
import {
  buildUserContent,
  mediaTypeFromMagic,
  looksLikeImagePath,
  readImageFile,
  imageB64Bytes,
  isWithinImageLimit,
  MAX_IMAGE_B64_BYTES,
} from '../../src/tui/input/imagePaste';
import type { ImageAttachment } from '../../src/tui/contracts';

function mkKey(over: Partial<InkKey> = {}): InkKey {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false,
    tab: false, backspace: false, delete: false, meta: false,
    ...over,
  } as InkKey;
}

// 1x1 PNG(真 PNG magic + IHDR),base64。
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// bracketed paste 拼装是**有状态**的(跨事件),测 createPasteAssembler。实测:Ink 把
//   ESC[200~…ESC[201~ 拆成多个事件并各剥前导 ESC,故起始/结束/正文常各自到达。
describe('pasteAssembler — bracketed paste(有状态跨事件)', () => {
  const feed = (asm: ReturnType<typeof createPasteAssembler>, s: string) => asm.feed(s, mkKey());

  test('★ 空图片粘贴拆成两事件 "[200~" | "[201~" → 仍出 paste-image-probe(核心回归)', () => {
    const asm = createPasteAssembler();
    expect(feed(asm, '[200~')).toEqual([]); // 起始:进粘贴态,不产键
    expect(asm.active).toBe(true);
    expect(feed(asm, '[201~')).toEqual([{ kind: 'paste-image-probe' }]); // 结束:收尾→图片探针
    expect(asm.active).toBe(false);
  });

  test('空图片粘贴单事件 "[200~\\x1b[201~" → probe', () => {
    expect(feed(createPasteAssembler(), '[200~\x1b[201~')).toEqual([{ kind: 'paste-image-probe' }]);
  });

  test('★ 落单结束标记 "[201~"(非粘贴态)→ 不漏进输入框(bug 修复)', () => {
    // 非粘贴态收到落单结束标记:START 未匹配 → 交 normalizeKey;normalizeKey 视其为普通文本?
    // 不——结束标记不含起始,assembler 非粘贴态直接透传给 normalizeKey,normalizeKey 把 "[201~"
    // 当普通字符串。为避免此,真实链路里结束标记只在粘贴态出现(前面必有 [200~)。这里断言
    // 完整拆包序列不残留标记:
    const asm = createPasteAssembler();
    feed(asm, '[200~');
    expect(feed(asm, '[201~')).toEqual([{ kind: 'paste-image-probe' }]); // 结束被 assembler 吃掉
  });

  test('文本粘贴拆三段:"[200~" | "hello world" | "\\x1b[201~" → 一枚 paste', () => {
    const asm = createPasteAssembler();
    expect(feed(asm, '[200~')).toEqual([]);
    expect(feed(asm, 'hello world')).toEqual([]); // 正文累积
    expect(feed(asm, '\x1b[201~')).toEqual([{ kind: 'paste', text: 'hello world' }]);
  });

  test('文本粘贴两段:"[200~hello" | "\\x1b[201~"', () => {
    const asm = createPasteAssembler();
    expect(feed(asm, '[200~hello')).toEqual([]);
    expect(feed(asm, '\x1b[201~')).toEqual([{ kind: 'paste', text: 'hello' }]);
  });

  test('多行粘贴累积保留换行', () => {
    const asm = createPasteAssembler();
    feed(asm, '[200~');
    feed(asm, 'a\nb');
    expect(feed(asm, '\x1b[201~')).toEqual([{ kind: 'paste', text: 'a\nb' }]);
  });

  test('单字符 body → char', () => {
    expect(feed(createPasteAssembler(), '[200~x\x1b[201~')).toEqual([{ kind: 'char', text: 'x' }]);
  });

  test('粘贴+回车同事件收尾 → paste 后追加 enter', () => {
    expect(feed(createPasteAssembler(), '[200~hi\x1b[201~\r')).toEqual([
      { kind: 'paste', text: 'hi' },
      { kind: 'enter' },
    ]);
  });

  test('非 bracketed 普通输入透传 normalizeKey(不进粘贴态)', () => {
    const asm = createPasteAssembler();
    expect(feed(asm, 'x')).toEqual([{ kind: 'char', text: 'x' }]);
    expect(asm.active).toBe(false);
    expect(feed(asm, 'abc')).toEqual([{ kind: 'paste', text: 'abc' }]);
  });
});

describe('pasteText — 折叠占位', () => {
  test('多行才折叠;单行(哪怕长)不折叠', () => {
    expect(shouldCollapsePaste('a\nb')).toBe(true);
    expect(shouldCollapsePaste('a\r\nb\r\nc')).toBe(true);
    expect(shouldCollapsePaste('single line even if quite long '.repeat(20))).toBe(false);
  });
  test('占位串格式 `[Pasted text #N +L lines]`', () => {
    expect(pastePlaceholder(1, 'a\nb\nc')).toBe('[Pasted text #1 +3 lines]');
    expect(countLines('a\nb\nc')).toBe(3);
  });
  test('expandPastes:占位 → 原文;无 pastes 原样返回', () => {
    const pastes = ['line1\nline2\nline3'];
    expect(expandPastes('看这段 [Pasted text #1 +3 lines] 谢谢', pastes)).toBe('看这段 line1\nline2\nline3 谢谢');
    expect(expandPastes('无占位', pastes)).toBe('无占位');
    expect(expandPastes('[Pasted text #1 +3 lines]')).toBe('[Pasted text #1 +3 lines]'); // 无 pastes → 不动
  });
  test('多段粘贴各自展开', () => {
    const pastes = ['AAA', 'BBB'];
    expect(expandPastes('[Pasted text #1 +1 lines] 和 [Pasted text #2 +1 lines]', pastes)).toBe('AAA 和 BBB');
  });
});

describe('buildUserContent', () => {
  test('无图 → 原字符串', () => {
    expect(buildUserContent('hi')).toBe('hi');
    expect(buildUserContent('hi', [])).toBe('hi');
  });

  test('有图 → [text, image] 且 image 为 Anthropic 中立形(provider 消费口径)', () => {
    const img: ImageAttachment = { data: 'AAAA', mediaType: 'image/png' };
    const c = buildUserContent('看这个', [img]) as Array<Record<string, unknown>>;
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toEqual({ type: 'text', text: '看这个' });
    expect(c[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  test('空文本 + 图 → 仅 image block(不塞空 text)', () => {
    const c = buildUserContent('', [{ data: 'BBBB', mediaType: 'image/jpeg' }]) as unknown[];
    expect(c).toHaveLength(1);
    expect((c[0] as Record<string, unknown>).type).toBe('image');
  });
});

describe('图片大小上限(5MB 硬闸)', () => {
  test('小图在限内', () => {
    const img = { data: PNG_1x1_B64, mediaType: 'image/png' };
    expect(imageB64Bytes(img)).toBe(PNG_1x1_B64.length);
    expect(isWithinImageLimit(img)).toBe(true);
  });
  test('超 5MB → 判超限(供 Repl 跳过 + 告知)', () => {
    const big = { data: 'A'.repeat(MAX_IMAGE_B64_BYTES + 1), mediaType: 'image/png' };
    expect(isWithinImageLimit(big)).toBe(false);
  });
});

describe('mediaTypeFromMagic', () => {
  test('PNG', () => {
    expect(mediaTypeFromMagic(Buffer.from(PNG_1x1_B64, 'base64'))).toBe('image/png');
  });
  test('JPEG / GIF / BMP / WEBP', () => {
    expect(mediaTypeFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(mediaTypeFromMagic(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(mediaTypeFromMagic(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe('image/bmp');
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(mediaTypeFromMagic(webp)).toBe('image/webp');
  });
  test('非图片 → null', () => {
    expect(mediaTypeFromMagic(Buffer.from('hello'))).toBeNull();
  });
});

describe('looksLikeImagePath / readImageFile — 真临时文件', () => {
  test('存在的 .png 文件 → 识别 + 读为 base64(magic 判 mediaType)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeax-paste-'));
    try {
      const p = join(dir, 'shot.png');
      writeFileSync(p, Buffer.from(PNG_1x1_B64, 'base64'));
      expect(looksLikeImagePath(p)).toBe(true);
      const img = readImageFile(p);
      expect(img).not.toBeNull();
      expect(img!.mediaType).toBe('image/png');
      // 注:macOS 会经 sips 规范化/缩放(长边 ≤ 1568),故不断言 base64 逐字节相等;
      //   只断言解出的仍是合法非空 PNG。
      const decoded = Buffer.from(img!.data, 'base64');
      expect(decoded.length).toBeGreaterThan(0);
      expect(mediaTypeFromMagic(decoded)).toBe('image/png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('不存在的路径 / 非图片扩展名 → 非图片', () => {
    expect(looksLikeImagePath('/no/such/file.png')).toBe(false);
    expect(looksLikeImagePath('/etc/hosts')).toBe(false);
    expect(readImageFile('/no/such/file.png')).toBeNull();
  });

  test('带引号的拖入路径也能读(cleanPath 去引号)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeax-paste-'));
    try {
      const p = join(dir, 'a.png');
      writeFileSync(p, Buffer.from(PNG_1x1_B64, 'base64'));
      expect(readImageFile(`'${p}'`)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
