/**
 * 分层指令装载测试(T2)—— AGENTS.md / CLAUDE.md + rules + @import。
 *
 * 覆盖:
 *   - discover:三层发现(user/project/local)、AGENTS.md canonical + CLAUDE.md 别名、
 *     同目录纯别名去重、rules 两姿态目录发现。
 *   - import:内联展开、相对/~/绝对解析、fenced code block 不展开、
 *     环检测(不死循环)、深度超限截断、单文件 40k 截断。
 *   - load:指令 + 无条件 rules 装载、带 paths: 的 rule 跳过。
 *   - pack/slot:instructionsPack → static slot;空项目 → 无 slot。
 *   - 装配顺序:assembleCapabilities 下 instructions slot 排在 memory 之前。
 *
 * 用临时目录(mkdtempSync)造各层文件。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverInstructions,
  isPureAliasOf,
  expandImports,
  loadAndExpand,
  loadInstructions,
  instructionsPack,
  makeInstructionsSlot,
  MAX_IMPORT_DEPTH,
  MAX_FILE_CHARS,
} from '../src/capability/instructions/index';
import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';
import { NodeSandboxFs } from '../src/cli/io';

const dirs: string[] = [];
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'fx-instr-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** 造一套 host dirs(cwd/userForgeax/userClaude 三个独立空目录)。 */
function makeDirs(): { cwd: string; userForgeax: string; userClaude: string } {
  return { cwd: mk(), userForgeax: mk(), userClaude: mk() };
}

// ─── discover ──────────────────────────────────────────────────────────────

describe('discoverInstructions', () => {
  test('finds AGENTS.md (canonical) + CLAUDE.md (alias) across layers, user→project→local', () => {
    const d = makeDirs();
    writeFileSync(join(d.userForgeax, 'AGENTS.md'), 'user forgeax');
    writeFileSync(join(d.userClaude, 'CLAUDE.md'), 'user claude');
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'project agents');
    writeFileSync(join(d.cwd, 'AGENTS.local.md'), 'local agents');
    const { files } = discoverInstructions(d);
    expect(files.map((f) => f.label)).toEqual([
      'user instructions',
      'user instructions',
      'project instructions',
      'local instructions',
    ]);
    expect(files[2]!.path).toBe(join(d.cwd, 'AGENTS.md'));
  });

  test('same-dir dedup: CLAUDE.md that only @imports sibling AGENTS.md is dropped', () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'the real doc');
    writeFileSync(join(d.cwd, 'CLAUDE.md'), '@AGENTS.md\n');
    const { files } = discoverInstructions(d);
    expect(files.map((f) => f.path)).toEqual([join(d.cwd, 'AGENTS.md')]);
  });

  test('same-dir: CLAUDE.md with its own body is kept alongside AGENTS.md', () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'agents body');
    writeFileSync(join(d.cwd, 'CLAUDE.md'), '# extra\nsome claude-only content');
    const { files } = discoverInstructions(d);
    expect(files.length).toBe(2);
  });

  test('rules discovered from .forgeax/rules + .claude/rules (project) and user rules', () => {
    const d = makeDirs();
    mkdirSync(join(d.cwd, '.forgeax', 'rules'), { recursive: true });
    mkdirSync(join(d.cwd, '.claude', 'rules'), { recursive: true });
    mkdirSync(join(d.userForgeax, 'rules'), { recursive: true });
    writeFileSync(join(d.cwd, '.forgeax', 'rules', 'a.md'), 'rule a');
    writeFileSync(join(d.cwd, '.claude', 'rules', 'b.md'), 'rule b');
    writeFileSync(join(d.userForgeax, 'rules', 'u.md'), 'rule u');
    const { rules } = discoverInstructions(d);
    expect(rules.map((r) => r.label)).toEqual(['user rule', 'project rule', 'project rule']);
  });
});

describe('isPureAliasOf', () => {
  const read = (m: Record<string, string>) => (abs: string) => {
    if (m[abs] === undefined) throw new Error('nope');
    return m[abs]!;
  };
  test('detects pure @import alias', () => {
    expect(isPureAliasOf('/p/CLAUDE.md', '/p/AGENTS.md', '/p', read({ '/p/CLAUDE.md': '@AGENTS.md' }))).toBe(true);
  });
  test('rejects when CLAUDE.md has real body', () => {
    expect(
      isPureAliasOf('/p/CLAUDE.md', '/p/AGENTS.md', '/p', read({ '/p/CLAUDE.md': '@AGENTS.md\nplus text' })),
    ).toBe(false);
  });
  test('rejects when import points elsewhere', () => {
    expect(isPureAliasOf('/p/CLAUDE.md', '/p/AGENTS.md', '/p', read({ '/p/CLAUDE.md': '@other.md' }))).toBe(false);
  });
});

// ─── import expansion ────────────────────────────────────────────────────────

describe('expandImports', () => {
  test('inline-expands a relative @import', () => {
    const base = mk();
    writeFileSync(join(base, 'child.md'), 'CHILD-BODY');
    const out = expandImports('before @child.md after', base);
    expect(out).toBe('before CHILD-BODY after');
  });

  test('recursively expands nested imports', () => {
    const base = mk();
    writeFileSync(join(base, 'a.md'), 'A @b.md');
    writeFileSync(join(base, 'b.md'), 'B');
    expect(loadAndExpand(join(base, 'a.md'))).toBe('A B');
  });

  test('does not expand @path inside fenced code blocks', () => {
    const base = mk();
    writeFileSync(join(base, 'x.md'), 'X');
    const src = ['```', '@x.md', '```', '@x.md'].join('\n');
    const out = expandImports(src, base);
    expect(out).toBe(['```', '@x.md', '```', 'X'].join('\n'));
  });

  test('cycle detection: import-back does not loop, leaves a note', () => {
    const base = mk();
    writeFileSync(join(base, 'a.md'), 'A @b.md');
    writeFileSync(join(base, 'b.md'), 'B @a.md');
    const out = loadAndExpand(join(base, 'a.md'));
    expect(out).toContain('A B');
    expect(out).toContain('cycle at @a.md');
    // no infinite loop → finite string
    expect(out.length).toBeLessThan(1000);
  });

  test('depth limit: imports beyond MAX_IMPORT_DEPTH are truncated', () => {
    const base = mk();
    // chain root → l1 → l2 → l3 → l4 → l5
    writeFileSync(join(base, 'root.md'), 'R @l1.md');
    for (let i = 1; i <= 5; i++) {
      const next = i < 5 ? `@l${i + 1}.md` : 'END';
      writeFileSync(join(base, `l${i}.md`), `L${i} ${next}`);
    }
    const out = loadAndExpand(join(base, 'root.md'));
    // l1..l4 expanded; l5 import at depth 4 is skipped
    expect(out).toContain('L4');
    expect(out).toContain(`max depth ${MAX_IMPORT_DEPTH} exceeded at @l5.md`);
    expect(out).not.toContain('END');
  });

  test('per-file cap: oversized import is truncated', () => {
    const base = mk();
    const big = 'x'.repeat(MAX_FILE_CHARS + 500);
    writeFileSync(join(base, 'big.md'), big);
    const out = expandImports('@big.md', base);
    expect(out).toContain('import truncated');
    expect(out.length).toBeLessThan(MAX_FILE_CHARS + 200);
  });

  test('non-path @token (e.g. email-ish) is left untouched', () => {
    const base = mk();
    // `@%weird` is not path-like → not treated as import
    expect(expandImports('see @%weird here', base)).toBe('see @%weird here');
  });

  test('unreadable import leaves a note (graceful)', () => {
    const base = mk();
    expect(expandImports('@missing.md', base)).toContain('not readable');
  });
});

// ─── load orchestration ──────────────────────────────────────────────────────

describe('loadInstructions', () => {
  test('assembles instruction files + unconditional rules; skips rules with paths:', () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'PROJECT-MARK');
    mkdirSync(join(d.cwd, '.forgeax', 'rules'), { recursive: true });
    writeFileSync(join(d.cwd, '.forgeax', 'rules', 'always.md'), 'ALWAYS-RULE');
    writeFileSync(
      join(d.cwd, '.forgeax', 'rules', 'cond.md'),
      '---\npaths:\n  - "src/**"\n---\nCONDITIONAL-RULE',
    );
    const { text, sources } = loadInstructions(d);
    expect(text).toContain('PROJECT-MARK');
    expect(text).toContain('ALWAYS-RULE');
    expect(text).not.toContain('CONDITIONAL-RULE');
    expect(sources).toContain(join(d.cwd, 'AGENTS.md'));
    expect(text).toContain('Project & user instructions');
  });

  test('empty project → empty text', () => {
    const d = makeDirs();
    expect(loadInstructions(d).text).toBe('');
  });

  test('@import inside AGENTS.md is expanded in the assembled text', () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'TOP-MARK\n@sub.md');
    writeFileSync(join(d.cwd, 'sub.md'), 'SUB-MARK');
    const { text } = loadInstructions(d);
    expect(text).toContain('TOP-MARK');
    expect(text).toContain('SUB-MARK');
  });
});

// ─── slot + pack ─────────────────────────────────────────────────────────────

describe('makeInstructionsSlot', () => {
  test('static, renders snapshot; empty → null', () => {
    const slot = makeInstructionsSlot('hello');
    expect(slot.dynamic).toBe(false);
    expect(slot.render({})).toBe('hello');
    expect(makeInstructionsSlot('   ').render({})).toBeNull();
  });
});

describe('instructionsPack', () => {
  test('no instructions → no slots', () => {
    expect(instructionsPack(makeDirs()).slots ?? []).toEqual([]);
  });
  test('with AGENTS.md → one instructions slot', () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'X');
    const pack = instructionsPack(d);
    expect(pack.slots?.length).toBe(1);
    expect(pack.slots?.[0]!.name).toBe('instructions');
  });
});

// ─── assembly ordering (instructions before memory) ───────────────────────────

describe('assembleCapabilities slot order', () => {
  test('instructions slot precedes memory slots', async () => {
    const d = makeDirs();
    writeFileSync(join(d.cwd, 'AGENTS.md'), 'ORDER-MARK');
    const bus = new EventBus();
    const sandboxFs = new NodeSandboxFs();
    const assembled = await assembleCapabilities({
      bus,
      instructions: d,
      memory: { dir: join(d.cwd, '.forgeax', 'memory'), sandboxFs },
    });
    const names = assembled.slots.map((s) => s.name);
    const iInstr = names.indexOf('instructions');
    const iMem = names.findIndex((n) => n === 'memory' || n === 'memory-behavior');
    expect(iInstr).toBeGreaterThanOrEqual(0);
    expect(iMem).toBeGreaterThan(iInstr);
    for (const dsp of assembled.disposers) await dsp();
  });
});
