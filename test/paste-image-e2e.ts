/**
 * 粘贴图片 E2E —— 真系统剪贴板(layer 4)+ 全链路映射(layer 2/5)。
 *
 * 不是 .test.ts(bun test 不自动收:要真读系统剪贴板 / osascript;CI headless 无剪贴板)。
 * 手动跑:
 *   bun packages/cli/test/paste-image-e2e.ts
 * 退出码 = 失败数。非 macOS(无 osascript 写剪贴板)时清晰跳过 layer4(exit 0)。
 *
 * 验证四段(对齐 docs/paste-image-alignment.md 四层):
 *   L2  normalize:空 bracketed paste → paste-image-probe(图片唯一信号)。
 *   L4  真剪贴板往返:把一张真 PNG 用 osascript 塞进系统剪贴板 → readClipboardImageSync()
 *       读回 → base64 解出 PNG magic,证明「Cmd+V 图片」在本机真能读到二进制。
 *   L5a buildUserContent → Anthropic 中立 block(source.type='base64' + media_type + data)。
 *   L5b 真 provider 变换:messagesToAnthropic / messagesToOpenAI 把该 block 落成各自 wire 形
 *       (Anthropic 透传 image block;OpenAI → image_url data:URL),证明模型侧不丢图。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key as InkKey } from 'ink';
import { createPasteAssembler } from '../src/tui/input/pasteAssembler';
import { buildUserContent, readClipboardImageSync, readImageFile, isWithinImageLimit } from '../src/tui/input/imagePaste';
import { messagesToAnthropic } from '../src/provider/anthropic';
import { messagesToOpenAI } from '../src/provider/openai-compat';
import type { ProviderMessage } from '../src/provider/types';

const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function mkKey(over: Partial<InkKey> = {}): InkKey {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false,
    tab: false, backspace: false, delete: false, meta: false,
    ...over,
  } as InkKey;
}

// ── L2:pasteAssembler 空粘贴 → probe(含真实拆包:"[200~" | "[201~" 两事件)──────
console.log('L2 pasteAssembler:空 bracketed paste → paste-image-probe');
{
  // 单事件形态
  const one = createPasteAssembler().feed('[200~\x1b[201~', mkKey());
  ok(one.length === 1 && one[0]!.kind === 'paste-image-probe', '单事件空粘贴 → probe', one);
  // ★ 真实拆包形态(Ink 把空粘贴拆成两事件)——这是图片粘贴"没反应"的根因回归
  const asm = createPasteAssembler();
  const a = asm.feed('[200~', mkKey());
  const b = asm.feed('[201~', mkKey());
  ok(a.length === 0 && b.length === 1 && b[0]!.kind === 'paste-image-probe', '拆包两事件 "[200~"|"[201~" → probe', { a, b });
}

// ── L4:真系统剪贴板往返(仅 macOS 能程序化写剪贴板图片)──────────────────────
console.log('L4 真剪贴板往返(macOS):写 PNG → 读回');
if (process.platform === 'darwin') {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-clip-e2e-'));
  try {
    const src = join(dir, 'fixture.png');
    writeFileSync(src, Buffer.from(PNG_1x1_B64, 'base64'));
    // 把文件的 PNG 数据塞进系统剪贴板(模拟「截图/拷贝图片」的效果)。
    execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${src}") as «class PNGf»)`]);
    const img = readClipboardImageSync();
    ok(img !== null, 'readClipboardImageSync 读到图片');
    if (img) {
      ok(img.mediaType === 'image/png', 'mediaType = image/png', img.mediaType);
      const buf = Buffer.from(img.data, 'base64');
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      ok(isPng, '解出的 base64 是合法 PNG(magic 89 50 4E 47)', buf.subarray(0, 4).toString('hex'));
      ok(buf.length > 0, 'PNG 非空', buf.length);
    }
  } catch (e) {
    ok(false, `L4 剪贴板操作异常:${(e as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log(`  ⏭  跳过(平台 ${process.platform},无法程序化写系统剪贴板图片)`);
}

// ── L4b:大图自动缩到 API 上限内(macOS sips)────────────────────────────────
console.log('L4b 大图缩放(macOS sips):3000×2000 PNG → 长边 ≤ 1568 且在 5MB 内');
if (process.platform === 'darwin') {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-fit-e2e-'));
  try {
    const seed = join(dir, 'seed.png');
    const big = join(dir, 'big.png');
    writeFileSync(seed, Buffer.from(PNG_1x1_B64, 'base64'));
    // 用 sips 把 1x1 重采样放大成 3000×2000(制造超尺寸原图)。
    execFileSync('sips', ['-z', '2000', '3000', seed, '--out', big], { stdio: 'ignore' });
    const img = readImageFile(big);
    ok(img !== null, 'readImageFile 读到大图');
    if (img) {
      ok(isWithinImageLimit(img), '缩放后在 5MB 内', img.data.length);
      // 把结果落盘,用 sips 量长边 ≤ 1568,证明确实缩过。
      const outPng = join(dir, 'out.png');
      writeFileSync(outPng, Buffer.from(img.data, 'base64'));
      const w = Number(execFileSync('sips', ['-g', 'pixelWidth', outPng], { encoding: 'utf8' }).match(/pixelWidth:\s*(\d+)/)?.[1]);
      const h = Number(execFileSync('sips', ['-g', 'pixelHeight', outPng], { encoding: 'utf8' }).match(/pixelHeight:\s*(\d+)/)?.[1]);
      ok(Math.max(w, h) <= 1568, `长边 ≤ 1568(实测 ${w}×${h})`, `${w}x${h}`);
    }
  } catch (e) {
    ok(false, `L4b sips 操作异常:${(e as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log(`  ⏭  跳过(平台 ${process.platform},无 sips)`);
}

// ── L5a:buildUserContent 中立 block ─────────────────────────────────────────
console.log('L5a buildUserContent → Anthropic 中立 block');
const userMsg: ProviderMessage = {
  role: 'user',
  content: buildUserContent('这张图是什么?', [{ data: PNG_1x1_B64, mediaType: 'image/png' }]),
};
{
  const c = userMsg.content as Array<Record<string, unknown>>;
  ok(Array.isArray(c) && c.length === 2, 'content = [text, image]', c);
  const imgBlock = c?.[1] as { type?: string; source?: Record<string, unknown> };
  ok(imgBlock?.type === 'image', 'block.type=image');
  ok(imgBlock?.source?.type === 'base64', 'source.type=base64');
  ok(imgBlock?.source?.media_type === 'image/png', 'source.media_type=image/png');
  ok(imgBlock?.source?.data === PNG_1x1_B64, 'source.data=原 base64');
}

// ── L5b:真 provider 变换不丢图 ──────────────────────────────────────────────
console.log('L5b provider 变换:Anthropic 透传 / OpenAI → image_url');
{
  const ant = messagesToAnthropic([userMsg]) as Array<{ content: unknown }>;
  const antBlocks = ant[0]!.content as Array<Record<string, unknown>>;
  const antImg = antBlocks.find((b) => b.type === 'image') as { source?: Record<string, unknown> } | undefined;
  ok(!!antImg, 'Anthropic:保留 image block');
  ok(antImg?.source?.data === PNG_1x1_B64, 'Anthropic:base64 完整透传');

  const oai = messagesToOpenAI([userMsg], []) as Array<{ content: unknown }>;
  const oaiParts = oai[0]!.content as Array<Record<string, unknown>>;
  const oaiImg = oaiParts.find((p) => p.type === 'image_url') as
    | { image_url?: { url?: string } }
    | undefined;
  ok(!!oaiImg, 'OpenAI:转成 image_url part');
  ok(
    typeof oaiImg?.image_url?.url === 'string' &&
      oaiImg.image_url.url === `data:image/png;base64,${PNG_1x1_B64}`,
    'OpenAI:image_url = data:image/png;base64,<原图>',
    oaiImg?.image_url?.url?.slice(0, 40),
  );
}

console.log(`\n${fail === 0 ? '✅' : '❌'} paste-image e2e: ${pass} pass / ${fail} fail`);
process.exit(fail);
