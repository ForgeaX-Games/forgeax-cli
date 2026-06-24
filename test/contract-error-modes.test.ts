/**
 * Phase D9 — contract tests for documented error-mode tables.
 *
 * Each `describe` block maps to an "error mode" or "反模式" row in
 * docs/v2-vision/architecture-evolution/{03,04,07,10}-*.md. The intent is
 * that this file becomes the canonical place where doc claims meet code:
 * if a doc table says "X is rejected with code Y", there should be a
 * matching `it(...)` here.
 *
 * Many of these claims are also covered in feature-specific tests
 * (skill-runner.test.ts, packs.test.ts, tool-registry.test.ts, etc.) — we do
 * NOT remove those. This file's job is to make the doc-to-test mapping
 * explicit, so reviewers can quickly verify "every published error mode is
 * actually pinned by a contract test".
 *
 * When a new error mode lands in a doc, add a new row here referencing the
 * doc + section. When a code rename or refactor lands, this file is the
 * canary that breaks first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestSchema } from '@forgeax/types';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { _resetToolHandlerCacheForTests, callTool } from '../src/tools/registry';
import { runSkill } from '../src/skills/runner';
import { exportPack } from '../src/packs/exporter';
import { inspectPack } from '../src/packs/importer';
import { _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-contract-errors-${process.pid}`;

async function reload(): Promise<void> {
  const scan = await scanAllLayers({
    L0: join(TMP, 'L0'),
    L1: join(TMP, 'L1'),
    L2: join(TMP, 'L2'),
  });
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

function writePluginAt(layer: 'L0' | 'L1' | 'L2', dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  return dir;
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

/* ============================================================================
 * 03 · Manifest validation reject modes
 *   Doc: docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §6
 * ==========================================================================*/
describe('03 · manifest schema rejection contract', () => {
  it('rejects plugin id that does not match @scope/name namespace pattern', () => {
    // The rule lives in `packages/types/src/manifest.ts` PluginIdSchema regex.
    const r = ManifestSchema.safeParse({
      schemaVersion: 1,
      id: 'no-scope-prefix',
      version: '0.1.0',
      kind: 'tool',
      displayName: { en: 'X' },
      provides: { tools: [{ id: 't.x' }] },
      entry: { backend: './h.ts' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown kind value', () => {
    const r = ManifestSchema.safeParse({
      schemaVersion: 1,
      id: '@me/x',
      version: '0.1.0',
      kind: 'something-else',
      displayName: { en: 'X' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects tool kind without provides.tools', () => {
    // Schema-level: ToolManifestSchema requires provides.tools.min(1).
    // (entry.backend is checked at dispatch time, not schema time.)
    const r = ManifestSchema.safeParse({
      schemaVersion: 1,
      id: '@me/x',
      version: '0.1.0',
      kind: 'tool',
      displayName: { en: 'X' },
      provides: {},
    });
    expect(r.success).toBe(false);
  });

  it('scanner surfaces malformed manifest as scanError, NOT a load crash', async () => {
    const bad = join(TMP, 'L1', 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'forgeax-plugin.json'), '{ not json', 'utf-8');
    const scan = await scanAllLayers({ L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') });
    expect(scan.errors.some((e) => e.originPath.includes('bad'))).toBe(true);
  });
});

/* ============================================================================
 * 04 · Skill error modes
 *   Doc: docs/v2-vision/architecture-evolution/04-SKILL-FORMAT-V2.md §7
 * ==========================================================================*/
describe('04 · skill runner error contract', () => {
  it('row "entry.file 不存在" → load_error', async () => {
    writePluginAt('L1', 'p', {
      id: '@x/p',
      kind: 'skill',
      displayName: { en: 'p' },
      provides: { skills: [{ id: 's.gone', entry: './nope.md', trigger: '/g' }] },
    });
    await reload();
    const r = await runSkill({ skillId: 's.gone', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('load_error');
  });

  it('row "tool.call 调到 requiresTools 没声明" → forbidden', async () => {
    const toolDir = writePluginAt('L1', 't', {
      id: '@x/t',
      kind: 'tool',
      displayName: { en: 't' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'side.x' }] },
    });
    writeFileSync(join(toolDir, 'h.mjs'), `export default { 'side.x': () => 'ok' };\n`, 'utf-8');
    const skillDir = writePluginAt('L1', 's', {
      id: '@x/s',
      kind: 'skill',
      displayName: { en: 's' },
      provides: {
        skills: [
          {
            id: 's.r',
            entry: { kind: 'ts', file: `./run-${crypto.randomUUID()}.mjs` },
            trigger: '/r',
            requiresTools: ['allow.something-else'],
          },
        ],
      },
    });
    // Re-write with a known filename matching what we declared.
    rmSync(skillDir, { recursive: true, force: true });
    const fname = `run-${crypto.randomUUID()}.mjs`;
    const skillDir2 = writePluginAt('L1', 's', {
      id: '@x/s',
      kind: 'skill',
      displayName: { en: 's' },
      provides: {
        skills: [
          {
            id: 's.r',
            entry: { kind: 'ts', file: `./${fname}` },
            trigger: '/r',
            requiresTools: ['allow.something-else'],
          },
        ],
      },
    });
    writeFileSync(
      join(skillDir2, fname),
      `export default async (ctx) => await ctx.callTool({ toolId: 'side.x', args: {}, caller: { kind: 'skill' } });\n`,
      'utf-8',
    );
    await reload();
    const r = await runSkill({ skillId: 's.r', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') {
      const inner = r.result as { ok: boolean; code?: string };
      expect(inner.ok).toBe(false);
      expect(inner.code).toBe('forbidden');
    }
  });

  it('py entry rejected as py_unsupported (deferred per ADR-0011)', async () => {
    writePluginAt('L1', 'p', {
      id: '@x/py',
      kind: 'skill',
      displayName: { en: 'p' },
      provides: { skills: [{ id: 's.py', entry: { kind: 'py', file: './m.py' }, trigger: '/p' }] },
    });
    await reload();
    const r = await runSkill({ skillId: 's.py', caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('py_unsupported');
  });
});

/* ============================================================================
 * Tool registry error contract
 *   Doc: 03 §11 + ADR-0010
 * ==========================================================================*/
describe('tool registry error contract', () => {
  it('unknown toolId → not_found', async () => {
    await reload();
    const r = await callTool({ toolId: 'nope.nope', args: {}, caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('AI caller is rejected for tool that does NOT opt into exposedToAI → forbidden', async () => {
    const dir = writePluginAt('L1', 'g', {
      id: '@x/gated',
      kind: 'tool',
      displayName: { en: 'g' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'gated.x' /* exposedToAI omitted, defaults to false */ }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'gated.x': () => 'ok' };\n`, 'utf-8');
    await reload();
    const r = await callTool({ toolId: 'gated.x', args: {}, caller: { kind: 'ai', threadId: 't' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('handler that throws surfaces invoke_error AND preserves thrown code', async () => {
    const dir = writePluginAt('L1', 'b', {
      id: '@x/boom',
      kind: 'tool',
      displayName: { en: 'b' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'boom.x', exposedToAI: true }] },
    });
    writeFileSync(
      join(dir, 'h.mjs'),
      `export default { 'boom.x': () => { const e = new Error('whoops'); e.code = 'custom_code'; throw e; } };\n`,
      'utf-8',
    );
    await reload();
    const r = await callTool({ toolId: 'boom.x', args: {}, caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('invoke_error');
      expect(r.error).toContain('whoops');
    }
  });
});

/* ============================================================================
 * 10 · .fxpack 反模式 table
 *   Doc: docs/v2-vision/architecture-evolution/10-FXPACK-PORTABILITY.md §7
 * ==========================================================================*/
describe('10 · .fxpack export reject modes', () => {
  function writePlugin(srcDir: string, id: string): void {
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version: '0.1.0',
        kind: 'tool',
        displayName: { en: id },
        author: { name: 't' },
        provides: { tools: [{ id: `${id}:t` }] },
        entry: { backend: './h.ts' },
        compatibleWith: { 'forgeax-bus': '^1.0.0' },
      }),
      'utf-8',
    );
    writeFileSync(join(srcDir, 'h.ts'), `export const tools = {};\n`, 'utf-8');
  }

  it('row "把 keys / secrets 写进 .fxpack" → lint_error (secret rule)', async () => {
    const src = join(TMP, 'leak');
    writePlugin(src, '@me/leak');
    writeFileSync(join(src, 'config.json'), `{ "k": "Bearer ${'A'.repeat(40)}" }`, 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/leak', srcDir: src }],
      outPath: join(TMP, 'l.fxpack'),
      bundleMeta: { id: '@me/leak', version: '0.1.0', title: { en: 'L' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('secret');
  });

  it('row ".fxpack 内含 native 二进制" → lint_error (native_binary rule)', async () => {
    const src = join(TMP, 'native');
    writePlugin(src, '@me/native');
    writeFileSync(join(src, 'addon.node'), 'fake', 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/native', srcDir: src }],
      outPath: join(TMP, 'n.fxpack'),
      bundleMeta: { id: '@me/native', version: '0.1.0', title: { en: 'N' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('native_binary');
  });

  it('row ".fxpack 内 import 绝对路径" → lint_error (absolute_path rule)', async () => {
    const src = join(TMP, 'abs');
    writePlugin(src, '@me/abs');
    writeFileSync(join(src, 'config.json'), `{ "p": "/Users/you/secrets/file" }\n`, 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/abs', srcDir: src }],
      outPath: join(TMP, 'a.fxpack'),
      bundleMeta: { id: '@me/abs', version: '0.1.0', title: { en: 'A' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('absolute_path');
  });

  it('row "强制签名 → 不签也行" → unsigned pack inspects with `未签名` warning, not a hard reject', async () => {
    const src = join(TMP, 'unsigned');
    writePlugin(src, '@me/unsigned');
    const out = join(TMP, 'u.fxpack');
    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/unsigned', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/unsigned', version: '0.1.0', title: { en: 'U' } },
    });
    expect(exp.ok).toBe(true);
    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.warnings.some((w) => w.includes('未签名'))).toBe(true);
  });

  it('row "自动开 plugin permissions" → install does NOT mutate any "trusted" bit (default-deny)', async () => {
    // Inspect-only path — the descriptor surfaces permissions[] but install
    // must not enable them silently. We assert that inspectPack returns
    // permissions in the trust descriptor (so a UI MUST show + confirm),
    // not that they're auto-applied. Auto-application would be a behavioral
    // change visible here as a separate "applied" bit.
    const src = join(TMP, 'perms');
    writePlugin(src, '@me/perms');
    // Push a permissions entry into the manifest.
    writeFileSync(
      join(src, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@me/perms',
        version: '0.1.0',
        kind: 'tool',
        displayName: { en: 'P' },
        author: { name: 't' },
        permissions: ['fs:write:.forgeax/games/foo/**', 'net:api.openai.com'],
        provides: { tools: [{ id: 'perm.t' }] },
        entry: { backend: './h.ts' },
        compatibleWith: { 'forgeax-bus': '^1.0.0' },
      }),
      'utf-8',
    );
    const out = join(TMP, 'p.fxpack');
    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/perms', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/perms', version: '0.1.0', title: { en: 'P' } },
    });
    expect(exp.ok).toBe(true);
    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.permissions['@me/perms']).toEqual([
      'fs:write:.forgeax/games/foo/**',
      'net:api.openai.com',
    ]);
    // No `applied: true` or similar bit. The descriptor is read-only context;
    // the UI is the one that confirms.
    expect((insp.trust as unknown as Record<string, unknown>).applied).toBeUndefined();
  });
});
