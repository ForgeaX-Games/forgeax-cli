/**
 * MEMpack tests — generic memory capability pack (C8).
 *
 * 覆盖:scan 解析 frontmatter + mtime 新→旧排序 + 封顶 200;recall 无 selectFn 回退取
 * 最新 N + selectFn 注入选择 + 选择器失败回退 + 幻觉文件名丢弃;remember 写闸(拒目录
 * 外)+ 写盘 + 重建索引;slot 注入索引封顶 entrypoint 预算;预算遵守(per-file 截断、
 * perTurnMaxFiles 上限)。用假同步 SandboxFs。
 *
 * **零 soul / T0-T1-T2 语义**:taxonomy 全经 type 字符串由测试传入。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, StatResult, DirEnt } from '../src/inject/types';
import { MEMORY_BUDGET, MEMORY_SEARCH_TOOL, REMEMBER_TOOL } from '../src/capability/memory-seam';
import { scanMemoryFiles, formatManifest } from '../src/capability/memory/scan';
import { findRelevantMemories } from '../src/capability/memory/recall';
import { isAutoMemPath, freshness } from '../src/capability/memory/tools';
import { memoryPack } from '../src/capability/memory';

// ─── fake SandboxFs (in-memory, sync surface only) ───────────────────────────────

interface FakeFile {
  content: string;
  mtime: number;
}

function fakeFs(seed: Record<string, FakeFile> = {}): SandboxFs & { dump(): Record<string, string> } {
  const files = new Map<string, FakeFile>();
  for (const [k, v] of Object.entries(seed)) files.set(norm(k), v);
  const dirs = new Set<string>();
  // seed parent dirs
  for (const k of files.keys()) {
    let p = parent(k);
    while (p && !dirs.has(p)) {
      dirs.add(p);
      p = parent(p);
    }
  }

  const ctx: SandboxFs & { dump(): Record<string, string> } = {
    readTextSync(path) {
      const f = files.get(norm(path));
      if (!f) throw new Error(`ENOENT ${path}`);
      return f.content;
    },
    writeTextSync(path, content) {
      const p = norm(path);
      files.set(p, { content, mtime: files.get(p)?.mtime ?? Date.now() });
      let d = parent(p);
      while (d) {
        dirs.add(d);
        d = parent(d);
      }
    },
    mkdirSync(path) {
      let d = norm(path);
      while (d) {
        dirs.add(d);
        d = parent(d);
      }
    },
    existsSync(path) {
      const p = norm(path);
      return files.has(p) || dirs.has(p);
    },
    unlinkSync(path) {
      files.delete(norm(path));
    },
    renameSync(from, to) {
      const f = files.get(norm(from));
      if (f) {
        files.set(norm(to), f);
        files.delete(norm(from));
      }
    },
    statSync(path): StatResult {
      const p = norm(path);
      const f = files.get(p);
      if (f) return { isFile: true, isDir: false, size: f.content.length, mtime: f.mtime };
      if (dirs.has(p)) return { isFile: false, isDir: true, size: 0, mtime: 0 };
      throw new Error(`ENOENT ${path}`);
    },
    readdirSync(path, opts): string[] | DirEnt[] {
      const root = norm(path);
      const children = new Map<string, { isFile: boolean; isDir: boolean }>();
      for (const k of files.keys()) {
        if (parent(k) === root) children.set(base(k), { isFile: true, isDir: false });
      }
      for (const d of dirs) {
        if (parent(d) === root) children.set(base(d), { isFile: false, isDir: true });
      }
      if (opts?.withFileTypes) {
        return [...children.entries()].map(([name, t]) => ({
          name,
          isFile: t.isFile,
          isDir: t.isDir,
          isSymlink: false,
        }));
      }
      return [...children.keys()];
    },
    async *readDir(path) {
      for (const ent of ctx.readdirSync(path, { withFileTypes: true }) as DirEnt[]) yield ent;
    },
    async readText(path) {
      return ctx.readTextSync(path);
    },
    async writeText(path, content) {
      ctx.writeTextSync(path, content);
    },
    async readBytes() {
      return new Uint8Array();
    },
    async writeBytes() {},
    readStream() {
      throw new Error('not impl');
    },
    writeStream() {
      throw new Error('not impl');
    },
    dump() {
      const out: Record<string, string> = {};
      for (const [k, v] of files) out[k] = v.content;
      return out;
    },
  };
  return ctx;
}

function norm(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}
function parent(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}
function base(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function mdFile(type: string, name: string, description: string, body: string, mtime: number): FakeFile {
  return {
    content: `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`,
    mtime,
  };
}

const DIR = '/mem';

// ─── scan ───────────────────────────────────────────────────────────────────────

describe('scanMemoryFiles', () => {
  test('parses frontmatter, sorts newest-first, excludes MEMORY.md', () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'desc-a', 'body a', 1000),
      '/mem/b.md': mdFile('project', 'B', 'desc-b', 'body b', 3000),
      '/mem/sub/c.md': mdFile('feedback', 'C', 'desc-c', 'body c', 2000),
      '/mem/MEMORY.md': { content: '# index', mtime: 9999 },
    });
    const headers = scanMemoryFiles(fs, DIR);
    expect(headers.map((h) => h.filename)).toEqual(['b.md', 'sub/c.md', 'a.md']);
    expect(headers[0].type).toBe('project');
    expect(headers[0].description).toBe('desc-b');
    expect(headers[0].name).toBe('B');
    // MEMORY.md excluded
    expect(headers.find((h) => h.filename === 'MEMORY.md')).toBeUndefined();
  });

  test('missing dir → []', () => {
    expect(scanMemoryFiles(fakeFs(), '/nope')).toEqual([]);
  });

  test('caps at 200 files (MAX_MEMORY_FILES)', () => {
    const seed: Record<string, FakeFile> = {};
    for (let i = 0; i < 250; i++) {
      seed[`/mem/f${i}.md`] = mdFile('user', `n${i}`, `d${i}`, 'x', i);
    }
    const headers = scanMemoryFiles(fakeFs(seed), DIR);
    expect(headers).toHaveLength(200);
    // newest-first → highest mtime survives
    expect(headers[0].mtimeMs).toBe(249);
  });

  test('formatManifest renders one line per file with type tag', () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'about a', 'body', 0) });
    const manifest = formatManifest(scanMemoryFiles(fs, DIR));
    expect(manifest).toContain('[user] a.md');
    expect(manifest).toContain('about a');
  });
});

// ─── recall ───────────────────────────────────────────────────────────────────────

describe('findRelevantMemories', () => {
  const fs = fakeFs({
    '/mem/a.md': mdFile('user', 'A', 'desc-a', 'x', 1000),
    '/mem/b.md': mdFile('user', 'B', 'desc-b', 'x', 3000),
    '/mem/c.md': mdFile('user', 'C', 'desc-c', 'x', 2000),
  });
  const headers = scanMemoryFiles(fs, DIR); // [b, c, a]

  test('no selectFn → fallback to newest N', async () => {
    const out = await findRelevantMemories(headers, 'q');
    expect(out.map((h) => h.filename)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  test('selectFn injection picks named files in selector order', async () => {
    const select = async (_manifest: string, _q: string) => ['a.md', 'c.md'];
    const out = await findRelevantMemories(headers, 'q', select);
    expect(out.map((h) => h.filename)).toEqual(['a.md', 'c.md']);
  });

  test('selectFn receives the manifest text', async () => {
    let seen = '';
    await findRelevantMemories(headers, 'topic', async (m) => {
      seen = m;
      return [];
    });
    expect(seen).toContain('b.md');
    expect(seen).toContain('desc-a');
  });

  test('hallucinated filenames are dropped', async () => {
    const out = await findRelevantMemories(headers, 'q', async () => ['ghost.md', 'b.md']);
    expect(out.map((h) => h.filename)).toEqual(['b.md']);
  });

  test('selectFn throwing → fallback to newest', async () => {
    const out = await findRelevantMemories(headers, 'q', async () => {
      throw new Error('boom');
    });
    expect(out.map((h) => h.filename)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  test('respects perTurnMaxFiles budget cap', async () => {
    const many: Record<string, FakeFile> = {};
    for (let i = 0; i < 10; i++) many[`/mem/m${i}.md`] = mdFile('user', `${i}`, `${i}`, 'x', i);
    const hs = scanMemoryFiles(fakeFs(many), DIR);
    const out = await findRelevantMemories(hs, 'q');
    expect(out.length).toBe(MEMORY_BUDGET.perTurnMaxFiles);
  });

  test('limit narrows but never exceeds budget', async () => {
    const out = await findRelevantMemories(headers, 'q', undefined, 2);
    expect(out).toHaveLength(2);
  });
});

// ─── write gate ───────────────────────────────────────────────────────────────────

describe('isAutoMemPath (write gate)', () => {
  test('allows paths inside memory dir', () => {
    expect(isAutoMemPath('/mem', '/mem/foo.md')).toBe(true);
    expect(isAutoMemPath('/mem', '/mem/sub/foo.md')).toBe(true);
    expect(isAutoMemPath('/mem', 'foo.md')).toBe(true); // relative resolves under root
  });
  test('rejects paths outside memory dir', () => {
    expect(isAutoMemPath('/mem', '/etc/passwd')).toBe(false);
    expect(isAutoMemPath('/mem', '/mem/../escape.md')).toBe(false);
    expect(isAutoMemPath('/mem', '../escape.md')).toBe(false);
    expect(isAutoMemPath('/mem', '/membership/x.md')).toBe(false); // prefix-not-boundary
  });
});

// ─── tools: remember + memory_search ────────────────────────────────────────────────

describe('memoryPack tools', () => {
  test('remember writes a .md with frontmatter + rebuilds index', async () => {
    const fs = fakeFs();
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const remember = pack.tools!.find((t) => t.name === REMEMBER_TOOL)!;
    const ctx = { signal: new AbortController().signal };
    const res = await remember.call(
      { type: 'note', name: 'My Pref', description: 'a preference', body: 'likes dark mode' },
      ctx,
    );
    const path = (res.data as { path: string }).path;
    expect(path).toBe('/mem/my-pref.md');
    const written = fs.readTextSync(path);
    expect(written).toContain('type: note');
    expect(written).toContain('likes dark mode');
    // index rebuilt
    expect(fs.existsSync('/mem/MEMORY.md')).toBe(true);
    expect(fs.readTextSync('/mem/MEMORY.md')).toContain('[note] my-pref.md');
  });

  test('memory_search returns hits with freshness + content', async () => {
    const fs = fakeFs({
      '/mem/x.md': mdFile('user', 'X', 'about x', 'content of x', Date.now()),
    });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const ctx = { signal: new AbortController().signal };
    const res = await search.call({ query: 'x' }, ctx);
    const hits = (res.data as { hits: Array<{ path: string; content: string; freshness?: string }> }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/mem/x.md');
    expect(hits[0].content).toContain('content of x');
    expect(hits[0].freshness).toBe('today');
  });

  test('memory_search per-file content clamped to budget', async () => {
    const big = 'L'.repeat(MEMORY_BUDGET.perFileMaxBytes + 5000);
    const fs = fakeFs({ '/mem/big.md': mdFile('user', 'Big', 'big one', big, Date.now()) });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const res = await search.call({ query: 'q' }, { signal: new AbortController().signal });
    const hits = (res.data as { hits: Array<{ content: string }> }).hits;
    expect(hits[0].content.length).toBeLessThanOrEqual(MEMORY_BUDGET.perFileMaxBytes);
  });

  test('memory_search honors injected selectFn', async () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'da', 'aaa', 2000),
      '/mem/b.md': mdFile('user', 'B', 'db', 'bbb', 1000),
    });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs, selectFn: async () => ['b.md'] });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const res = await search.call({ query: 'q' }, { signal: new AbortController().signal });
    const hits = (res.data as { hits: Array<{ path: string }> }).hits;
    expect(hits.map((h) => h.path)).toEqual(['/mem/b.md']);
  });

  test('freshness renders human age', () => {
    const now = Date.now();
    expect(freshness(now, now)).toBe('today');
    expect(freshness(now - 86_400_000, now)).toBe('yesterday');
    expect(freshness(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
});

// ─── slot ───────────────────────────────────────────────────────────────────────

describe('memory slot', () => {
  test('renders resident MEMORY.md index', async () => {
    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- [user] a.md (x): hi', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = await slot.render({});
    expect(out).toContain('MEMORY index');
    expect(out).toContain('a.md');
  });

  test('falls back to live manifest when index missing', async () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'desc-a', 'body', 0) });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = await slot.render({});
    expect(out).toContain('a.md');
  });

  test('empty memory → null (no injection)', async () => {
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fakeFs() });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    expect(await slot.render({})).toBeNull();
  });

  test('index render clamped to entrypoint byte budget', async () => {
    const huge = '- line\n'.repeat(MEMORY_BUDGET.entrypointMaxLines + 500);
    const fs = fakeFs({ '/mem/MEMORY.md': { content: `# i\n\n${huge}`, mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = (await slot.render({})) as string;
    expect(out.split('\n').length).toBeLessThanOrEqual(MEMORY_BUDGET.entrypointMaxLines);
    expect(out.length).toBeLessThanOrEqual(MEMORY_BUDGET.entrypointMaxBytes);
  });
});

// ─── pack shape ───────────────────────────────────────────────────────────────────

describe('memoryPack assembly', () => {
  test('exposes both tools + memory slot at builtin layer', () => {
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fakeFs() });
    expect(pack.name).toBe('memory');
    expect(pack.layer).toBe('builtin');
    expect(pack.tools!.map((t) => t.name).sort()).toEqual([MEMORY_SEARCH_TOOL, REMEMBER_TOOL].sort());
    // 行为提示 slot(怎么/何时写 + 召回信任)+ MEMORY.md 索引 slot,两者皆 static。
    expect(pack.slots!.map((s) => s.name)).toEqual(['memory-behavior', 'memory']);
  });
});

// ─── 记忆化:缓存前缀稳定(对齐 cc —— context 每会话装配一次,中途变化 append-only)──

describe('memory slot memoization (prompt-cache prefix stability)', () => {
  test('render byte-stable across turns even when MEMORY.md changes on disk', async () => {
    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- [user] a.md (t0): v1', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const first = await slot.render({});
    // 会话中途索引被重写(remember / auto-extract 的 rebuildIndex)……
    fs.writeTextSync('/mem/MEMORY.md', '# MEMORY index\n\n- [user] a.md (t0): v1\n- [note] b.md (t1): v2');
    // ……常驻渲染必须保持字节不变,否则 system prompt 静态段漂移 → 前缀缓存整体失效。
    expect(await slot.render({})).toBe(first);
  });

  test('memoizes empty (null) too — first mid-session save must not bust the prefix', async () => {
    const fs = fakeFs();
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    expect(await slot.render({})).toBeNull();
    const remember = pack.tools!.find((t) => t.name === REMEMBER_TOOL)!;
    await remember.call({ type: 'note', name: 'N', description: 'd', body: 'b' }, { signal: new AbortController().signal });
    expect(await slot.render({})).toBeNull(); // 索引已落盘,但本会话常驻段不变
  });

  test('invalidate() drops the memo and re-reads disk', async () => {
    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- v1', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')! as import('../src/capability/memory/slot').ResidentMemorySlot;
    expect(await slot.render({})).toContain('v1');
    fs.writeTextSync('/mem/MEMORY.md', '# MEMORY index\n\n- v2');
    slot.invalidate();
    expect(await slot.render({})).toContain('v2');
  });
});

describe('memory index invalidator plugin', () => {
  async function packWithBus() {
    const { EventBus } = await import('../src/events/event-bus');
    const { CoreEventType } = await import('../src/events/events');
    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- v1', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const bus = new EventBus();
    const dispose = await pack.plugins![0].start({ bus });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    return { fs, bus, slot, dispose, CoreEventType };
  }

  test('SessionEnd reason=clear invalidates; run-end reasons do not', async () => {
    const { fs, bus, slot, CoreEventType } = await packWithBus();
    expect(await slot.render({})).toContain('v1');
    fs.writeTextSync('/mem/MEMORY.md', '# MEMORY index\n\n- v2');
    // 每 run 收尾的 SessionEnd(reason=终态)不失效——TUI 下每条用户消息即一个 run,
    // 按 run 失效等于退回「每轮重读」的缓存 bug。
    bus.publish({ type: CoreEventType.SessionEnd, payload: { sessionId: 's', reason: 'completed' }, ts: 0 });
    expect(await slot.render({})).toContain('v1');
    bus.publish({ type: CoreEventType.SessionEnd, payload: { sessionId: 's', reason: 'clear' }, ts: 0 });
    expect(await slot.render({})).toContain('v2');
  });

  test('CompactionApplied invalidates', async () => {
    const { fs, bus, slot, CoreEventType } = await packWithBus();
    expect(await slot.render({})).toContain('v1');
    fs.writeTextSync('/mem/MEMORY.md', '# MEMORY index\n\n- v2');
    bus.publish({ type: CoreEventType.CompactionApplied, payload: {}, ts: 0 });
    expect(await slot.render({})).toContain('v2');
  });

  test('dispose unsubscribes; no bus in ctx degrades to no-op', async () => {
    const { fs, bus, slot, dispose, CoreEventType } = await packWithBus();
    expect(await slot.render({})).toContain('v1');
    dispose();
    fs.writeTextSync('/mem/MEMORY.md', '# MEMORY index\n\n- v2');
    bus.publish({ type: CoreEventType.SessionEnd, payload: { reason: 'clear' }, ts: 0 });
    expect(await slot.render({})).toContain('v1'); // 已退订,不再失效
    // 无 bus:start 不抛、返回可调用的 dispose。
    const bare = memoryPack({ memoryDir: DIR, sandboxFs: fakeFs() });
    const d = await bare.plugins![0].start({});
    expect(typeof d).toBe('function');
    d();
  });
});

describe('remember indexLine (append-only in-session delta)', () => {
  test('remember returns the canonical MEMORY.md index line', async () => {
    const fs = fakeFs();
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const remember = pack.tools!.find((t) => t.name === REMEMBER_TOOL)!;
    const res = await remember.call(
      { type: 'note', name: 'My Pref', description: 'a preference', body: 'likes dark mode' },
      { signal: new AbortController().signal },
    );
    const { indexLine } = res.data as { path: string; indexLine?: string };
    // 与 formatManifest 的行格式一致(SSOT):`- [type] filename (ISO): description`。
    expect(indexLine).toMatch(/^- \[note\] my-pref\.md \(.+\): a preference$/);
    // 且就是落盘索引里的那一行(派生,不另造格式)。
    expect(fs.readTextSync('/mem/MEMORY.md')).toContain(indexLine!);
  });
});

// ─── loop 级回归:轮间 remember 落盘,system prompt 静态段字节不变 ─────────────────
//   (whistle 抓包实证过的 bug:memory_save 后下一轮 system prompt 中段多出
//    `# MEMORY index`,前缀缓存整体失效——本测试在真实 CoreAgent loop 上钉死不复发。)

describe('loop regression: mid-run remember keeps system prompt byte-stable', () => {
  test('system blocks identical across turns while remember rewrites the index', async () => {
    const { CoreAgent } = await import('../src/agent/agent');
    const { EMPTY_USAGE } = await import('../src/provider/types');
    type StreamEvent = import('../src/provider/types').ProviderStreamEvent;
    type Req = import('../src/provider/types').ProviderRequest;

    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- [user] a.md (t0): v1', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });

    // 捕获每轮发给 provider 的 system blocks;turn1 让模型调 remember,turn2 收尾。
    const systems: string[] = [];
    let call = 0;
    const provider = {
      api: 'stub',
      async *stream(req: Req): AsyncGenerator<StreamEvent> {
        systems.push(JSON.stringify(req.system));
        call++;
        if (call === 1) {
          yield {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: REMEMBER_TOOL, input: { type: 'note', name: 'N', description: 'd', body: 'b' } }],
            },
            usage: EMPTY_USAGE,
            stopReason: 'tool_use',
          } as StreamEvent;
        } else {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            usage: EMPTY_USAGE,
            stopReason: 'end_turn',
          } as StreamEvent;
        }
      },
    };
    const agent = new CoreAgent({
      context: {
        agentId: 'a1',
        provider,
        config: { systemPromptSlots: pack.slots!, model: 'm', tools: pack.tools!, maxTurns: 4 },
        toolContext: {},
      },
    });
    const events: Array<{ type: string }> = [];
    for await (const e of agent.run({ input: { type: 'user', payload: 'remember this', ts: 0 } })) events.push(e);

    expect(events.at(-1)!.type).toBe('done');
    expect(call).toBe(2);
    // remember 已真实重写索引……
    expect(fs.readTextSync('/mem/MEMORY.md')).toContain('n.md');
    // ……但两轮的 system blocks 字节一致(静态前缀稳定,缓存不被打爆)。
    expect(systems[1]).toBe(systems[0]);
  });
});
