/**
 * C-01 — read_file 默认行上限 + 单行截断 + 结果预算兜底。
 *
 * 三道闸(对齐 CC/cbc):
 *   1. 不传 limit → 默认只读前 N 行(DEFAULT_READ_LINE_LIMIT),带分页提示;
 *   2. 单行超长 → 截断 + marker(防 minified JS 绕过行数闸);
 *   3. maxResultSizeChars 有界(非 Infinity)→ LOOP 全局预算兜底对 read 生效。
 *
 * 既有 offset/limit 分页行为零回归(见 builtin-tools.test.ts read_file 用例)。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import {
  builtinToolsPack,
  readFileTool,
  readFilesTool,
  DEFAULT_READ_LINE_LIMIT,
  MAX_READ_LINE_CHARS,
  MAX_READ_FILES,
  READ_FILES_MAX_RESULT_CHARS,
} from '../src/capability/builtin-tools/index';
import { applyResultBudget } from '../src/context/tool-result-budget';

// 最小 SandboxFs:read_file 文本路径只用 readText;readBytes 抛错以强制走文本路径。
class MemFs implements SandboxFs {
  private files = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }
  readTextSync(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  writeTextSync(p: string, c: string): void {
    this.files.set(p, c);
  }
  mkdirSync(): void {}
  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  unlinkSync(p: string): void {
    this.files.delete(p);
  }
  renameSync(): void {}
  statSync(): StatResult {
    return { isFile: true, isDir: false, size: 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async *readDir(): AsyncIterable<DirEnt> {}
  async readText(p: string): Promise<string> {
    return this.readTextSync(p);
  }
  async writeText(p: string, c: string): Promise<void> {
    this.writeTextSync(p, c);
  }
  async readBytes(): Promise<Uint8Array> {
    throw new Error('not an image');
  }
  async writeBytes(): Promise<void> {}
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('not used');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('not used');
  }
}

function ctxWith(fs: SandboxFs): ToolContext {
  return { signal: new AbortController().signal, sandboxFs: fs };
}

test('read_files rejects image results explicitly instead of serializing base64 as text', async () => {
  const fs = new MemFs({ '/ok.txt': 'hello' });
  const tool = readFilesTool();
  const { data } = await tool.call({ files: [{ file_path: '/image.png' }, { file_path: '/ok.txt' }] }, ctxWith(fs));
  expect(data.successful).toBe(1);
  expect(data.failed).toBe(1);
  expect(data.files[0]).toMatchObject({ ok: false, error: expect.stringContaining('use read_file') });
  expect(JSON.stringify(tool.mapResult(data, 'batch'))).not.toContain('imageBlocks');
});

describe('C-01 read_file default line limit', () => {
  test('exports sane budget constants', () => {
    expect(DEFAULT_READ_LINE_LIMIT).toBe(2000);
    expect(MAX_READ_LINE_CHARS).toBe(2000);
  });

  test('no limit → caps at DEFAULT_READ_LINE_LIMIT lines with pagination hint', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line${i + 1}`).join('\n');
    const fs = new MemFs({ '/big.txt': big });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/big.txt' }, ctxWith(fs));
    expect(data.totalLines).toBe(5000);
    expect(data.numLines).toBe(DEFAULT_READ_LINE_LIMIT); // 只返回前 2000 行
    expect(data.content).toContain('1\tline1');
    expect(data.content).toContain(`${DEFAULT_READ_LINE_LIMIT}\tline${DEFAULT_READ_LINE_LIMIT}`);
    expect(data.content).not.toContain(`\tline${DEFAULT_READ_LINE_LIMIT + 1}`); // 第 2001 行不返回
    // 带分页提示(告诉模型用 offset/limit 继续)
    expect(data.content.toLowerCase()).toMatch(/offset|limit|truncat|more lines|分页/);
  });

  test('super-long single line is truncated with marker', async () => {
    const longLine = 'x'.repeat(MAX_READ_LINE_CHARS + 500);
    const fs = new MemFs({ '/min.js': `short\n${longLine}\nend` });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/min.js' }, ctxWith(fs));
    // 超长行被截断到 ≤ MAX_READ_LINE_CHARS(+ marker overhead 少量)
    const lines = data.content.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    expect(longest).toBeLessThan(MAX_READ_LINE_CHARS + 200);
    expect(data.content).toMatch(/truncat/i);
  });
});

describe('C-01 read_file maxResultSizeChars is bounded', () => {
  test('read_file declares a finite maxResultSizeChars', () => {
    const t = readFileTool();
    expect(Number.isFinite(t.maxResultSizeChars)).toBe(true);
  });

  test('LOOP global budget actually truncates an over-limit read result', () => {
    const t = readFileTool();
    const raw = 'A'.repeat((t.maxResultSizeChars as number) + 10_000);
    const { output, truncated } = applyResultBudget(raw, t.maxResultSizeChars);
    expect(truncated).toBe(true);
    expect(output.length).toBeLessThanOrEqual(t.maxResultSizeChars as number);
  });
});

describe('C-01 zero-regression on offset/limit paging', () => {
  test('explicit offset+limit still paginates exactly', async () => {
    const fs = new MemFs({ '/a.txt': 'l1\nl2\nl3\nl4' });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt', offset: 2, limit: 2 }, ctxWith(fs));
    expect(data.numLines).toBe(2);
    expect(data.content).toContain('2\tl2');
    expect(data.content).toContain('3\tl3');
    expect(data.content).not.toContain('l1');
    expect(data.content).not.toContain('l4');
  });

  test('small file under limit returns all lines (no hint)', async () => {
    const fs = new MemFs({ '/s.txt': 'l1\nl2\nl3' });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/s.txt' }, ctxWith(fs));
    expect(data.numLines).toBe(3);
    expect(data.totalLines).toBe(3);
  });
});

describe('explicit read_files batching', () => {
  test('reads independent files in input order and preserves per-file failures', async () => {
    const fs = new MemFs({ '/a.txt': 'a1\na2', '/b.txt': 'b1' });
    const { data } = await readFilesTool().call({
      files: [{ file_path: '/a.txt' }, { file_path: '/missing.txt' }, { file_path: '/b.txt' }],
    }, ctxWith(fs));
    expect(data.successful).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.files.map((file) => file.file_path)).toEqual(['/a.txt', '/missing.txt', '/b.txt']);
    expect(data.files[0]).toMatchObject({ file_path: '/a.txt', ok: true, content: expect.stringContaining('a1') });
    expect(data.files[1]).toMatchObject({ file_path: '/missing.txt', ok: false, error: expect.stringContaining('ENOENT') });
    expect(data.files[2]).toMatchObject({ file_path: '/b.txt', ok: true, content: expect.stringContaining('b1') });
  });

  test('is explicitly bounded and advertised as a read-only concurrent builtin', () => {
    const tool = readFilesTool();
    expect(tool.name).toBe('read_files');
    expect(tool.isReadOnly({ files: [] })).toBe(true);
    expect(tool.isConcurrencySafe({ files: [] })).toBe(true);
    expect(tool.maxResultSizeChars).toBe(READ_FILES_MAX_RESULT_CHARS);
    expect(builtinToolsPack().tools?.map((item) => item.name)).toContain('read_files');
    expect(tool.inputJSONSchema?.properties).toHaveProperty('files');
  });

  test(`rejects more than ${MAX_READ_FILES} files instead of silently truncating the request`, async () => {
    const files = Array.from({ length: MAX_READ_FILES + 1 }, (_, i) => ({ file_path: `/f-${i}.txt` }));
    await expect(readFilesTool().call({ files }, ctxWith(new MemFs()))).rejects.toThrow(`at most ${MAX_READ_FILES}`);
  });

  test('caps aggregate text deterministically so a batch cannot multiply the read budget', async () => {
    const fs = new MemFs({ '/a.txt': 'a'.repeat(READ_FILES_MAX_RESULT_CHARS), '/b.txt': 'b'.repeat(READ_FILES_MAX_RESULT_CHARS) });
    const { data } = await readFilesTool().call({ files: [{ file_path: '/a.txt' }, { file_path: '/b.txt' }] }, ctxWith(fs));
    const successful = data.files.filter((file): file is Extract<typeof file, { ok: true }> => file.ok);
    expect(successful).toHaveLength(2);
    expect(successful.every((file) => file.content.length <= READ_FILES_MAX_RESULT_CHARS / 2 + 100)).toBe(true);
    expect(successful.some((file) => file.content.includes('truncated'))).toBe(true);
  });
});
