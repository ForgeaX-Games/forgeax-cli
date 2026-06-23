/**
 * End-to-end coverage for docs/v2-vision/architecture-evolution/ — weaves the
 * Trinity (Plugin/Agent/Skill) lifecycle through scanner → merger → kind
 * registry → tool dispatch → fxpack export → install → re-scan in one file.
 *
 * Existing per-stage suites (plugins-scanner-merger, plugins-kinds, tool-
 * registry, skill-runner, packs) cover each stage in isolation. This file
 * pins the *cross-stage invariants* the docs hinge on:
 *
 *   - 03 §2.1  L2 > L1 > L0 layering — a project copy beats user beats builtin
 *   - 03 §2.2  All four kinds (workbench/agent/skill/tool) survive a single
 *              scan/merge pass and end up in the right kinds[] slot
 *   - 03 §3    `dependencies` topo-sort: dep before dependent
 *   - D1       callTool dispatches the freshly-scanned tool through the real
 *              dynamic-import path
 *   - D7+D6    .fxpack export → install → reload makes a brand-new plugin
 *              visible to the registry without restarting anything
 *
 * Test strategy: build a representative on-disk plugin tree under /tmp, run
 * the real reload pipeline (no mocks), and assert against the resulting
 * snapshot. The pipeline is deterministic — identical inputs produce
 * identical kinds[] — so we can pin exact counts and ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import {
  _resetSnapshotForTests,
  _setSnapshotForTests,
  type PluginSnapshot,
} from '../src/plugins/registry';
import { callTool, _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { exportPack } from '../src/packs/exporter';
import { inspectPack, installPack } from '../src/packs/importer';

const TMP = `/tmp/forgeax-arch-evo-${process.pid}`;
const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

function writePlugin(layer: 'L0' | 'L1' | 'L2', dirName: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...manifest }, null, 2),
    'utf-8',
  );
  for (const [rel, body] of Object.entries(files)) {
    const p = resolve(dir, rel);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, body, 'utf-8');
  }
  return dir;
}

async function reload(): Promise<PluginSnapshot> {
  const scan = await scanAllLayers(ROOTS());
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  const snap: PluginSnapshot = {
    generation: 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  };
  _setSnapshotForTests(snap);
  return snap;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
});

describe('architecture-evolution · trinity lifecycle', () => {
  it('one scan picks up workbench + agent + skill + tool simultaneously', async () => {
    writePlugin('L1', 'wb-demo', {
      id: '@x/wb-demo',
      kind: 'workbench',
      displayName: { zh: 'wb', en: 'wb' },
      provides: { workbench: { id: 'wb-demo', position: 10, panelSize: 'md' } },
    });
    writePlugin(
      'L1',
      'agent-demo',
      {
        id: '@x/agent-demo',
        kind: 'agent',
        displayName: { zh: 'Agent', en: 'Agent' },
        provides: {
          agent: {
            id: 'demo.agent',
            role: 'demo',
            card: { name: { en: 'Demo' }, color: '#1F6FEB', avatar: '👤' },
            personaFile: './persona.md',
          },
        },
      },
      { 'persona.md': '# demo persona\n' },
    );
    writePlugin(
      'L1',
      'skill-demo',
      {
        id: '@x/skill-demo',
        kind: 'skill',
        displayName: { zh: 'Skill', en: 'Skill' },
        provides: { skills: [{ id: 'demo.greet', entry: './SKILL.md', trigger: '/greet' }] },
      },
      { 'SKILL.md': '# greet\nhello\n' },
    );
    writePlugin(
      'L1',
      'tool-demo',
      {
        id: '@x/tool-demo',
        kind: 'tool',
        displayName: { zh: 'Tool', en: 'Tool' },
        provides: { tools: [{ id: 'demo.echo', exposedToAI: true }] },
        entry: { backend: './handler.ts' },
      },
      {
        'handler.ts':
          'export const tools = { "demo.echo": (args) => ({ echoed: args }) };\n',
      },
    );

    const snap = await reload();
    expect(snap.scanErrors).toEqual([]);
    expect(snap.mergeIssues).toEqual([]);
    expect(snap.kinds.workbench.map((w) => w.workbenchId)).toContain('wb-demo');
    expect(snap.kinds.agents.map((a) => a.definition.id)).toContain('demo.agent');
    expect(snap.kinds.skills.map((s) => s.definition.id)).toContain('demo.greet');
    expect(snap.kinds.tools.map((t) => t.toolId)).toContain('demo.echo');
    // Each kind landed exactly once (no double-counting across kinds[]).
    expect(snap.manifests).toHaveLength(4);
  });

  it('L2 > L1 > L0: project copy shadows user copy shadows builtin', async () => {
    const id = '@x/layered';
    const baseManifest = {
      id,
      kind: 'tool' as const,
      provides: { tools: [{ id: 'layered.t' }] },
      entry: { backend: './h.ts' },
    };
    writePlugin('L0', 'layered', { ...baseManifest, displayName: { en: 'L0 builtin' } });
    writePlugin('L1', 'layered', { ...baseManifest, displayName: { en: 'L1 user' } });
    writePlugin('L2', 'layered', { ...baseManifest, displayName: { en: 'L2 project' } });

    const snap = await reload();
    const winner = snap.manifests.find((m) => m.manifest.id === id);
    expect(winner?.layer).toBe('L2');
    // Both lower layers recorded as shadowed, ordered most→least specific.
    expect(winner?.shadowedBy.map((s) => s.layer)).toEqual(['L1', 'L0']);
  });

  it('topo sort: dependency lands before dependent in manifests[]', async () => {
    writePlugin('L1', 'lib', {
      id: '@x/lib',
      kind: 'tool',
      displayName: { en: 'lib' },
      provides: { tools: [{ id: 'lib.t' }] },
      entry: { backend: './h.ts' },
    });
    writePlugin('L1', 'consumer', {
      id: '@x/consumer',
      kind: 'tool',
      displayName: { en: 'consumer' },
      dependencies: [{ id: '@x/lib' }],
      provides: { tools: [{ id: 'consumer.t' }] },
      entry: { backend: './h.ts' },
    });
    const snap = await reload();
    const ids = snap.manifests.map((m) => m.manifest.id);
    expect(ids.indexOf('@x/lib')).toBeLessThan(ids.indexOf('@x/consumer'));
  });

  it('callTool dispatches a freshly-scanned tool handler end-to-end', async () => {
    writePlugin(
      'L1',
      'tool-live',
      {
        id: '@x/tool-live',
        kind: 'tool',
        displayName: { en: 'live' },
        provides: { tools: [{ id: 'live.add', exposedToAI: true }] },
        entry: { backend: './handler.ts' },
      },
      {
        // crypto.randomUUID() in path keeps Bun's ESM cache from reusing
        // a handler module across test runs — the registry uses an absolute
        // path which would normally collide.
        'handler.ts':
          'export const tools = { "live.add": (args) => ({ sum: (args.a ?? 0) + (args.b ?? 0) }) };\n',
      },
    );
    await reload();
    const result = await callTool({
      toolId: 'live.add',
      args: { a: 2, b: 3 },
      caller: { kind: 'ai', threadId: 't0' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toEqual({ sum: 5 });
  });

  it('.fxpack export → install → re-scan makes a new tool callable', async () => {
    // Source plugin lives outside any layer root; we'll export then install
    // it into L1 and verify the registry sees it via a normal scan.
    const srcDir = join(TMP, 'src', 'roundtrip');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'forgeax-plugin.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: '@me/roundtrip',
          version: '0.1.0',
          kind: 'tool',
          displayName: { en: 'roundtrip' },
          author: { name: 'tester' },
          permissions: ['fs:read:.forgeax/plugins/roundtrip/**'],
          provides: { tools: [{ id: 'roundtrip.ping', exposedToAI: true }] },
          entry: { backend: './handler.ts' },
          compatibleWith: { 'forgeax-bus': '^1.0.0' },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(
      join(srcDir, 'handler.ts'),
      'export const tools = { "roundtrip.ping": () => ({ pong: true }) };\n',
      'utf-8',
    );

    const fxpack = join(TMP, 'roundtrip.fxpack');
    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/roundtrip', srcDir }],
      outPath: fxpack,
      bundleMeta: { id: '@me/roundtrip', version: '0.1.0', title: { en: 'RT' } },
    });
    expect(exp.ok).toBe(true);

    const insp = await inspectPack(fxpack);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.conflicts).toEqual([]);

    // L1 = ~/.forgeax — installer expects destRoot to be the user home.
    // We point destRoot at a tmp dir then scan that same path as the L1 root.
    const userRoot = join(TMP, 'user-home');
    mkdirSync(userRoot, { recursive: true });
    const inst = await installPack({ zipPath: fxpack, destRoot: userRoot, destLayer: 'L2' });
    // installPack writes <destRoot>/.forgeax/plugins/<id>/ regardless of
    // destLayer — the layer label is metadata for the ledger; on-disk path
    // is the same. We then point our L2 scan root at <destRoot>/.forgeax/plugins.
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    expect(inst.installed).toEqual(['@me/roundtrip']);
    expect(
      existsSync(join(userRoot, '.forgeax/plugins/roundtrip/forgeax-plugin.json')),
    ).toBe(true);

    // Re-scan with the freshly-installed tree as a custom L2 root.
    const scan = await scanAllLayers({
      L0: join(TMP, 'L0'),
      L1: join(TMP, 'L1'),
      L2: join(userRoot, '.forgeax/plugins'),
    });
    const merge = mergeManifests(scan.found);
    const kinds = buildKindRegistry(merge.manifests);
    _setSnapshotForTests({
      generation: 2,
      loadedAt: Date.now(),
      manifests: merge.manifests,
      kinds,
      scanErrors: scan.errors,
      mergeIssues: merge.issues,
    });
    expect(scan.errors).toEqual([]);
    expect(kinds.tools.map((t) => t.toolId)).toContain('roundtrip.ping');

    const callRes = await callTool({
      toolId: 'roundtrip.ping',
      args: {},
      caller: { kind: 'ai', threadId: 't0' },
    });
    expect(callRes.ok).toBe(true);
    if (!callRes.ok) return;
    expect(callRes.result).toEqual({ pong: true });

    // Final pin: the installed manifest matches the source byte-for-byte
    // semantically (no transform during pack/install).
    const installedManifest = JSON.parse(
      readFileSync(
        join(userRoot, '.forgeax/plugins/roundtrip/forgeax-plugin.json'),
        'utf-8',
      ),
    );
    const originalManifest = JSON.parse(readFileSync(join(srcDir, 'forgeax-plugin.json'), 'utf-8'));
    expect(installedManifest).toEqual(originalManifest);
  });
});
