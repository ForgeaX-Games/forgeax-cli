/**
 * Auto-memory tests:auto recall(per-turn 注入)+
 * auto extract(done 后台抽取)+ provider-backed selectFn,以及 loop 集成。
 */
import { test, expect, describe } from 'bun:test';
import { AutoMemory, makeProviderSelectFn, type ForkRunner } from '../src/capability/memory/auto';
import { makeMemoryDirCanUseTool } from '../src/capability/memory/extract-prompt';
import { memoryFreshnessText } from '../src/capability/memory/tools';
import { CoreAgent, type AutoMemoryHook } from '../src/agent/agent';
import type { SandboxFs, DirEnt } from '../src/inject/types';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

/** 极简内存 SandboxFs(平铺目录)。 */
class MemFs {
  files = new Map<string, { content: string; mtime: number }>();
  set(path: string, content: string, mtime = 1): void {
    this.files.set(path, { content, mtime });
  }
  existsSync(p: string): boolean {
    return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p.replace(/\/$/, '') + '/'));
  }
  mkdirSync(): void {}
  writeTextSync(p: string, c: string): void {
    this.files.set(p, { content: c, mtime: 999 });
  }
  readTextSync(p: string): string {
    const f = this.files.get(p);
    if (!f) throw new Error('ENOENT ' + p);
    return f.content;
  }
  statSync(p: string): { isFile: boolean; isDir: boolean; size: number; mtime: number } {
    const f = this.files.get(p);
    return { isFile: true, isDir: false, size: f?.content.length ?? 0, mtime: f?.mtime ?? 0 };
  }
  readdirSync(dir: string, opts?: { withFileTypes?: boolean }): string[] | DirEnt[] {
    const prefix = dir.replace(/\/$/, '') + '/';
    const names = [...this.files.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((n) => !n.includes('/'));
    if (opts?.withFileTypes) return names.map((name) => ({ name, isFile: true, isDir: false, isSymlink: false }));
    return names;
  }
}
const asFs = (m: MemFs): SandboxFs => m as unknown as SandboxFs;

const DIR = '/mem';
function seed(): MemFs {
  const m = new MemFs();
  m.set(`${DIR}/foo.md`, `---\nname: Foo\ndescription: about foo\ntype: user\n---\nfoo body here`, 10);
  m.set(`${DIR}/bar.md`, `---\nname: Bar\ndescription: about bar\ntype: project\n---\nbar body here`, 20);
  return m;
}

function jsonProvider(json: string): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
    },
  };
}

describe('auto recall', () => {
  test('selectFn-picked memory injected as a system-reminder', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), selectFn: async () => ['foo.md'] });
    const out = await am.recall('tell me about foo');
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('foo body here');
    expect(out).toContain('Memory ('); // freshness header
  });

  test('surfaced dedup: second recall does not re-surface the same file', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), selectFn: async () => ['foo.md'] });
    await am.recall('query one');
    const out2 = await am.recall('query two'); // foo already surfaced → selectFn only sees bar (which it won't pick)
    expect(out2 == null || !out2.includes('foo body here')).toBe(true);
  });

  test('no selectFn → falls back to newest, never empty when memories exist', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs) });
    const out = await am.recall('anything relevant');
    expect(out).toContain('bar body here'); // bar mtime=20 newest
  });

  test('missing dir → null (no crash)', async () => {
    const am = new AutoMemory({ memoryDir: '/nope', sandboxFs: asFs(new MemFs()) });
    expect(await am.recall('query here')).toBeNull();
  });

  test('gate: empty / single-word query → null (low-signal, no select)', async () => {
    const fs = seed();
    let selectCalls = 0;
    const am = new AutoMemory({
      memoryDir: DIR,
      sandboxFs: asFs(fs),
      selectFn: async () => {
        selectCalls++;
        return ['foo.md'];
      },
    });
    expect(await am.recall('')).toBeNull();
    expect(await am.recall('   ')).toBeNull();
    expect(await am.recall('snake')).toBeNull(); // single word
    expect(selectCalls).toBe(0); // gated before select
    expect(await am.recall('make a snake game')).not.toBeNull(); // multi-word → runs
  });
});

describe('auto extract (cache-safe fork)', () => {
  /** mock forkRunner:模拟 fork 内模型用 Write 工具写一个 memory 文件,返回写过的路径。 */
  function writingFork(fs: MemFs, path: string, body: string): ForkRunner {
    return async () => {
      fs.writeTextSync(path, body);
      return [path];
    };
  }

  test('runs fork + rebuilds index after a successful extraction', async () => {
    const fs = new MemFs();
    const am = new AutoMemory({
      memoryDir: DIR,
      sandboxFs: asFs(fs),
      forkRunner: writingFork(fs, `${DIR}/likes-dark-mode.md`, '---\nname: x\n---\nuser prefers dark mode'),
    });
    await am.extract([{ role: 'user', content: 'I prefer dark mode' }]);
    const written = [...fs.files.keys()];
    expect(written.some((p) => p.endsWith('likes-dark-mode.md'))).toBe(true);
    expect(written.some((p) => p.endsWith('/MEMORY.md'))).toBe(true); // rebuildIndex ran
    expect(fs.readTextSync(`${DIR}/likes-dark-mode.md`)).toContain('user prefers dark mode');
  });

  test('throttle: extractEveryNTurns=2 skips the first call (fork not invoked)', async () => {
    const fs = new MemFs();
    let forkCalls = 0;
    const fork: ForkRunner = async () => {
      forkCalls++;
      fs.writeTextSync(`${DIR}/x.md`, 'b');
      return [`${DIR}/x.md`];
    };
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), forkRunner: fork, extractEveryNTurns: 2 });
    await am.extract([{ role: 'user', content: 'a' }]);
    expect(forkCalls).toBe(0); // throttled
    await am.extract([{ role: 'user', content: 'b' }]);
    expect(forkCalls).toBe(1);
  });

  test('no forkRunner → no-op (cold path deleted)', async () => {
    const fs = new MemFs();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs) });
    await am.extract([{ role: 'user', content: 'a' }]);
    expect(fs.files.size).toBe(0);
  });

  test('consolidation: fires a distill fork once file count ≥ threshold', async () => {
    const fs = seed(); // 2 files already (foo.md, bar.md)
    let extractForks = 0;
    let consolidateForks = 0;
    const fork: ForkRunner = async (_pm, instruction) => {
      if (instruction.includes('consolidation subagent')) {
        consolidateForks++;
        return [`${DIR}/merged.md`];
      }
      extractForks++;
      fs.writeTextSync(`${DIR}/new.md`, '---\nname: n\n---\nnew');
      return [`${DIR}/new.md`];
    };
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), forkRunner: fork, consolidateThreshold: 2 });
    await am.extract([{ role: 'user', content: 'remember this' }]);
    expect(extractForks).toBe(1);
    expect(consolidateForks).toBe(1); // 3 files (foo/bar/new) ≥ threshold 2 → consolidation ran
  });

  test('consolidation: off by default (threshold 0) → no distill fork', async () => {
    const fs = seed();
    let consolidateForks = 0;
    const fork: ForkRunner = async (_pm, instruction) => {
      if (instruction.includes('consolidation subagent')) consolidateForks++;
      return [];
    };
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), forkRunner: fork }); // no threshold
    await am.extract([{ role: 'user', content: 'remember this too' }]);
    expect(consolidateForks).toBe(0);
  });

  test('write-gate: makeMemoryDirCanUseTool allows in-dir writes, denies escapes + non-mem tools', () => {
    const gate = makeMemoryDirCanUseTool(DIR);
    expect(gate('Read', { file_path: '/anywhere' })).toBe(true); // read-only allowed
    expect(gate('Grep', {})).toBe(true);
    expect(gate('Write', { file_path: `${DIR}/traits/fav.md` })).toBe(true); // in-dir write
    expect(gate('Write', { file_path: '/etc/passwd' })).toBe(false); // escape denied
    expect(gate('Edit', { file_path: `${DIR}/../oops.md` })).toBe(false); // traversal denied
    expect(gate('Bash', { command: 'rm -rf /' })).toBe(false); // non-mem tool denied
  });
});

describe('memoryFreshnessText (Step8 data-side freshness)', () => {
  const NOW = 1_000 * 86_400_000; // a fixed "now" in ms
  test('fresh (today/yesterday) → no caveat', () => {
    expect(memoryFreshnessText(NOW, NOW)).toBe('');
    expect(memoryFreshnessText(NOW - 86_400_000, NOW)).toBe(''); // yesterday
  });
  test('stale (>1 day) → point-in-time caveat with age', () => {
    const out = memoryFreshnessText(NOW - 5 * 86_400_000, NOW);
    expect(out).toContain('5 days old');
    expect(out).toContain('point-in-time');
    expect(out).toContain('Verify against current code');
  });
  test('recall surfaces caveat for a stale memory file', async () => {
    const fs = seed(); // foo/bar mtime ~1970 → very stale vs real now
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), selectFn: async () => ['foo.md'] });
    const out = await am.recall('tell me about foo');
    expect(out).toContain('days old'); // caveat injected into the recall block
  });
});

describe('makeProviderSelectFn', () => {
  test('parses {"selected":[...]} from provider (incl `json fence)', async () => {
    const provider = jsonProvider('```json\n{"selected":["a.md","b.md"]}\n```');
    const fn = makeProviderSelectFn(provider, 'm');
    expect(await fn('manifest', 'q')).toEqual(['a.md', 'b.md']);
  });
});

describe('loop integration', () => {
  function ctx(): AgentContext {
    return {
      agentId: 'a',
      provider: jsonProvider('all done'),
      config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 4 },
      toolContext: {},
    };
  }
  test('CoreAgent calls recall once and extract on completed', async () => {
    let recalls = 0;
    let extracts = 0;
    const spy: AutoMemoryHook = {
      async recall() {
        recalls++;
        return '<system-reminder>mem</system-reminder>';
      },
      async extract() {
        extracts++;
      },
    };
    const agent = new CoreAgent({ context: ctx(), autoMemory: spy });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      /* drain */
    }
    await agent.drainAutoMemory();
    expect(recalls).toBe(1);
    expect(extracts).toBe(1);
  });
});
