/**
 * Phase D4 — SkillRunner tests. Covers prompt entry, ts entry with default
 * + named exports, tool permission shim, py rejection, error paths, and
 * skill.* event auto-emit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { runSkill, listSkills } from '../src/skills/runner';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-skill-runner-${process.pid}`;
const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

async function reload() {
  const scan = await scanAllLayers(ROOTS());
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  _setSnapshotForTests({
    generation: 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

function writeManifest(dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, 'L1', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  return dir;
}

describe('SkillRunner', () => {
  it('runs a prompt-entry skill and returns the file text', async () => {
    const dir = writeManifest('prompt-skill', {
      id: '@x/prompt-skill',
      kind: 'skill',
      displayName: { zh: 'p', en: 'p' },
      provides: { skills: [{ id: 's.hello', entry: './SKILL.md', trigger: '/hello' }] },
    });
    writeFileSync(join(dir, 'SKILL.md'), '# Hello world prompt\n', 'utf-8');
    await reload();
    const r = await runSkill({ skillId: 's.hello', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'prompt') {
      expect(r.text).toContain('Hello world prompt');
    } else {
      throw new Error('expected prompt result');
    }
  });

  it('returns not_found when skill is missing', async () => {
    await reload();
    const r = await runSkill({ skillId: 'nope', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('rejects py entry as py_unsupported', async () => {
    writeManifest('py-skill', {
      id: '@x/py-skill',
      kind: 'skill',
      displayName: { zh: 'p', en: 'p' },
      provides: {
        skills: [
          {
            id: 's.py',
            entry: { kind: 'py', file: './main.py' },
            trigger: '/py',
          },
        ],
      },
    });
    await reload();
    const r = await runSkill({ skillId: 's.py', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('py_unsupported');
  });

  it('runs a ts skill with default export', async () => {
    const dir = writeManifest('ts-skill', {
      id: '@x/ts-skill',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.add',
            entry: { kind: 'ts', file: `./skill-${crypto.randomUUID()}.mjs` },
            trigger: '/add',
          },
        ],
      },
    });
    // Recover the actual generated filename from the just-loaded snapshot.
    await reload();
    const skills = listSkills();
    const file = skills[0].kind === 'ts' ? null : null; // shape only
    void file;
    // The above is decorative — we know the file we wrote since we generated
    // the name. Easier to just regenerate deterministically:
    rmSync(dir, { recursive: true, force: true });
    const dir2 = writeManifest('ts-skill', {
      id: '@x/ts-skill',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.add',
            entry: { kind: 'ts', file: './skill.mjs' },
            trigger: '/add',
          },
        ],
      },
    });
    writeFileSync(
      join(dir2, 'skill.mjs'),
      `export default async (ctx) => ctx.input.x + ctx.input.y;\n`,
      'utf-8',
    );
    await reload();
    const r = await runSkill({ skillId: 's.add', input: { x: 3, y: 4 }, caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') expect(r.result).toBe(7);
  });

  it('runs a ts skill with named export', async () => {
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const dir = writeManifest('ts-named', {
      id: '@x/ts-named',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.named',
            entry: { kind: 'ts', file: `./${fname}`, export: 'run' },
            trigger: '/n',
          },
        ],
      },
    });
    writeFileSync(join(dir, fname), `export const run = () => 'ok';\n`, 'utf-8');
    await reload();
    const r = await runSkill({ skillId: 's.named', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') expect(r.result).toBe('ok');
  });

  it('rejects ts skill missing the requested export', async () => {
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const dir = writeManifest('ts-noex', {
      id: '@x/ts-noex',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.noex',
            entry: { kind: 'ts', file: `./${fname}`, export: 'missing' },
            trigger: '/x',
          },
        ],
      },
    });
    writeFileSync(join(dir, fname), `export const present = () => 1;\n`, 'utf-8');
    await reload();
    const r = await runSkill({ skillId: 's.noex', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_export');
  });

  it('blocks tool calls not declared in requiresTools', async () => {
    // Set up a tool that the skill MIGHT call.
    const toolDir = writeManifest('tool-x', {
      id: '@x/tool-x',
      kind: 'tool',
      displayName: { zh: 't', en: 't' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'side.work' }] },
    });
    writeFileSync(join(toolDir, 'h.mjs'), `export default { 'side.work': () => 'ok' };\n`, 'utf-8');
    // Skill that does NOT declare requiresTools but tries to call side.work.
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const skillDir = writeManifest('skill-restricted', {
      id: '@x/skill-restricted',
      kind: 'skill',
      displayName: { zh: 's', en: 's' },
      provides: {
        skills: [
          {
            id: 's.restricted',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/r',
            requiresTools: ['something.else'],
          },
        ],
      },
    });
    writeFileSync(
      join(skillDir, fname),
      `export default async (ctx) => {
         const r = await ctx.callTool({ toolId: 'side.work', args: {}, caller: { kind: 'skill' } });
         return r;
       };\n`,
      'utf-8',
    );
    await reload();
    const r = await runSkill({ skillId: 's.restricted', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') {
      const inner = r.result as { ok: boolean; code?: string };
      expect(inner.ok).toBe(false);
      expect(inner.code).toBe('forbidden');
    }
  });

  it('allows tool calls declared in requiresTools', async () => {
    const handlerName = `h-${crypto.randomUUID()}.mjs`;
    const toolDir = writeManifest('tool-ok', {
      id: '@x/tool-ok',
      kind: 'tool',
      displayName: { zh: 't', en: 't' },
      entry: { backend: `./${handlerName}` },
      provides: { tools: [{ id: 'allowed.t' }] },
    });
    writeFileSync(join(toolDir, handlerName), `export default { 'allowed.t': () => 'pong' };\n`, 'utf-8');

    const fname = `sk-${crypto.randomUUID()}.mjs`;
    const skillDir = writeManifest('skill-ok', {
      id: '@x/skill-ok',
      kind: 'skill',
      displayName: { zh: 's', en: 's' },
      provides: {
        skills: [
          {
            id: 's.ok',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/ok',
            requiresTools: ['allowed.t'],
          },
        ],
      },
    });
    writeFileSync(
      join(skillDir, fname),
      `export default async (ctx) => {
         const r = await ctx.callTool({ toolId: 'allowed.t', args: {}, caller: { kind: 'skill' } });
         return r.ok ? r.result : null;
       };\n`,
      'utf-8',
    );
    await reload();
    const r = await runSkill({ skillId: 's.ok', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') expect(r.result).toBe('pong');
  });

  it('emits skill.starting + skill.completed on the bus', async () => {
    const dir = writeManifest('emit-skill', {
      id: '@x/emit-skill',
      kind: 'skill',
      displayName: { zh: 'e', en: 'e' },
      provides: { skills: [{ id: 's.emit', entry: './E.md', trigger: '/e' }] },
    });
    writeFileSync(join(dir, 'E.md'), 'hi', 'utf-8');
    await reload();
    const got: string[] = [];
    getEventBus().subscribe('skill.*', (e) => got.push(e.topic));
    await runSkill({ skillId: 's.emit', caller: { kind: 'user', threadId: 'th' } });
    expect(got).toEqual(['skill.starting', 'skill.completed']);
  });

  it('emits skill.failed when prompt file is missing', async () => {
    writeManifest('missing-prompt', {
      id: '@x/missing-prompt',
      kind: 'skill',
      displayName: { zh: 'm', en: 'm' },
      provides: { skills: [{ id: 's.gone', entry: './gone.md', trigger: '/g' }] },
    });
    await reload();
    const got: string[] = [];
    getEventBus().subscribe('skill.*', (e) => got.push(e.topic));
    const r = await runSkill({ skillId: 's.gone', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('load_error');
    expect(got).toEqual(['skill.starting', 'skill.failed']);
  });

  it('input schema: rejects bad shape with input_invalid', async () => {
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const dir = writeManifest('io-in', {
      id: '@x/io-in',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.io.in',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/i',
            io: { input: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
          },
        ],
      },
    });
    writeFileSync(join(dir, fname), `export default ({ input }) => input.name.toUpperCase();\n`, 'utf-8');
    await reload();
    const bad = await runSkill({ skillId: 's.io.in', input: { wrong: 1 }, caller: { kind: 'user' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('input_invalid');
    const ok = await runSkill({ skillId: 's.io.in', input: { name: 'lock' }, caller: { kind: 'user' } });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.kind === 'ts') expect(ok.result).toBe('LOCK');
  });

  it('output schema: rejects bad shape with output_invalid', async () => {
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const dir = writeManifest('io-out', {
      id: '@x/io-out',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.io.out',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/o',
            io: { output: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } },
          },
        ],
      },
    });
    writeFileSync(join(dir, fname), `export default () => ({ n: 'not-int' });\n`, 'utf-8');
    await reload();
    const r = await runSkill({ skillId: 's.io.out', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('output_invalid');
  });

  it('timeout: aborts ts skill that exceeds timeoutMs', async () => {
    const fname = `s-${crypto.randomUUID()}.mjs`;
    const dir = writeManifest('to', {
      id: '@x/to',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.slow',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/s',
            timeoutMs: 50,
          },
        ],
      },
    });
    writeFileSync(join(dir, fname), `export default () => new Promise((res) => setTimeout(() => res('late'), 200));\n`, 'utf-8');
    await reload();
    const r = await runSkill({ skillId: 's.slow', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('timeout');
  });

  it('P7: readPluginFile is gated by fs:read permissions', async () => {
    // Glob against absolute path: runner resolves relPath against originDir
    // before checking. We use `**/data/**` so the match works regardless of
    // the test's tmp dir layout.
    const dir = writeManifest('fs-gate', {
      id: '@x/fs-gate',
      kind: 'skill',
      displayName: { zh: 'g', en: 'g' },
      provides: {
        skills: [
          {
            id: 's.allow',
            entry: { kind: 'ts', file: './allow.ts' },
            trigger: '/allow',
            permissions: [{ kind: 'fs', mode: 'read', path: '**/data/**' }],
          },
          {
            id: 's.deny',
            entry: { kind: 'ts', file: './deny.ts' },
            trigger: '/deny',
            permissions: [{ kind: 'fs', mode: 'read', path: '**/data/**' }],
          },
        ],
      },
    });
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'ok.txt'), 'sentinel', 'utf-8');
    writeFileSync(join(dir, 'secret.txt'), 'must-not-be-read', 'utf-8');
    writeFileSync(
      join(dir, 'allow.ts'),
      `export default (ctx) => ctx.readPluginFile('data/ok.txt').trim();\n`,
      'utf-8',
    );
    writeFileSync(
      join(dir, 'deny.ts'),
      `export default (ctx) => { try { return ctx.readPluginFile('secret.txt'); } catch (e) { return 'BLOCKED:' + e.message; } };\n`,
      'utf-8',
    );
    await reload();

    const okR = await runSkill({ skillId: 's.allow', caller: { kind: 'user' } });
    expect(okR.ok).toBe(true);
    if (okR.ok && okR.kind === 'ts') expect(okR.result).toBe('sentinel');

    const denyR = await runSkill({ skillId: 's.deny', caller: { kind: 'user' } });
    expect(denyR.ok).toBe(true);
    if (denyR.ok && denyR.kind === 'ts') expect(String(denyR.result)).toContain('BLOCKED:');
  });

  it('listSkills surfaces id/kind/triggers/requiresTools', async () => {
    writeManifest('catalog', {
      id: '@x/catalog',
      kind: 'skill',
      displayName: { zh: 'c', en: 'c' },
      provides: {
        skills: [
          {
            id: 's.one',
            entry: './A.md',
            trigger: '/one',
            requiresTools: ['x.y'],
            displayName: { zh: '一', en: 'One' },
            description: { zh: '描述', en: 'Desc' },
          },
        ],
      },
    });
    await reload();
    const list = listSkills();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('s.one');
    expect(list[0].kind).toBe('prompt');
    expect(list[0].requiresTools).toEqual(['x.y']);
    expect(list[0].triggers[0]).toEqual({ kind: 'slash', command: 'one' });
  });

  describe('Doc 14 §4 — static-import lint (sandbox spike)', () => {
    it('refuses to load a ts skill that imports node:fs without fs permissions', async () => {
      const dir = writeManifest('lint-fs', {
        id: '@x/lint-fs',
        kind: 'skill',
        displayName: { zh: 'lf', en: 'lf' },
        provides: {
          skills: [{ id: 's.fs', entry: { kind: 'ts', file: './s.mjs' }, triggers: [{ kind: 'slash', command: 'fs' }] }],
        },
      });
      writeFileSync(
        join(dir, 's.mjs'),
        `import { readFileSync } from 'node:fs';\nexport default () => readFileSync('/etc/hosts','utf-8');\n`,
        'utf-8',
      );
      await reload();
      const r = await runSkill({ skillId: 's.fs', caller: { kind: 'user' } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('load_error');
        expect(r.error).toContain('fs');
        expect(r.error).toContain("kind:'fs'");
      }
    });

    it('allows node:fs when fs permission is declared', async () => {
      const dir = writeManifest('allow-fs', {
        id: '@x/allow-fs',
        kind: 'skill',
        displayName: { zh: 'af', en: 'af' },
        provides: {
          skills: [{
            id: 's.fs2',
            entry: { kind: 'ts', file: './s.mjs' },
            triggers: [{ kind: 'slash', command: 'fs2' }],
            permissions: [{ kind: 'fs', mode: 'read', path: '**' }],
          }],
        },
      });
      writeFileSync(
        join(dir, 's.mjs'),
        `import { readFileSync } from 'node:fs';\nexport default () => 'ok';\n`,
        'utf-8',
      );
      await reload();
      const r = await runSkill({ skillId: 's.fs2', caller: { kind: 'user' } });
      expect(r.ok).toBe(true);
      if (r.ok && r.kind === 'ts') expect(r.result).toBe('ok');
    });

    it('flat-denies vm and worker_threads regardless of declared permissions', async () => {
      const dir = writeManifest('deny-vm', {
        id: '@x/deny-vm',
        kind: 'skill',
        displayName: { zh: 'd', en: 'd' },
        provides: {
          skills: [{
            id: 's.vm',
            entry: { kind: 'ts', file: './s.mjs' },
            triggers: [{ kind: 'slash', command: 'vm' }],
            permissions: [
              { kind: 'fs', mode: 'read', path: '**' },
              { kind: 'spawn', cmd: '*' },
            ],
          }],
        },
      });
      writeFileSync(
        join(dir, 's.mjs'),
        `import { runInNewContext } from 'node:vm';\nexport default () => 1;\n`,
        'utf-8',
      );
      await reload();
      const r = await runSkill({ skillId: 's.vm', caller: { kind: 'user' } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('load_error');
        expect(r.error).toContain('forbidden');
      }
    });

    it('refuses child_process import without spawn permissions', async () => {
      const dir = writeManifest('deny-cp', {
        id: '@x/deny-cp',
        kind: 'skill',
        displayName: { zh: 'd', en: 'd' },
        provides: {
          skills: [{ id: 's.cp', entry: { kind: 'ts', file: './s.mjs' }, triggers: [{ kind: 'slash', command: 'cp' }] }],
        },
      });
      writeFileSync(
        join(dir, 's.mjs'),
        `import cp from 'child_process';\nexport default () => 1;\n`,
        'utf-8',
      );
      await reload();
      const r = await runSkill({ skillId: 's.cp', caller: { kind: 'user' } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('load_error');
        expect(r.error).toContain("kind:'spawn'");
      }
    });

    it('skill that does not import any guarded builtin loads cleanly', async () => {
      const dir = writeManifest('clean', {
        id: '@x/clean',
        kind: 'skill',
        displayName: { zh: 'c', en: 'c' },
        provides: {
          skills: [{ id: 's.clean', entry: { kind: 'ts', file: './s.mjs' }, triggers: [{ kind: 'slash', command: 'cl' }] }],
        },
      });
      writeFileSync(join(dir, 's.mjs'), `export default () => 'pure';\n`, 'utf-8');
      await reload();
      const r = await runSkill({ skillId: 's.clean', caller: { kind: 'user' } });
      expect(r.ok).toBe(true);
      if (r.ok && r.kind === 'ts') expect(r.result).toBe('pure');
    });
  });
});
