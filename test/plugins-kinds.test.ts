/**
 * Phase B2 unit tests for kind loaders. Builds disposable manifests in
 * /tmp and verifies workbench/skill/agent entries materialize correctly.
 *
 * w3 additions: requireConfirm three-value enum pass-through via loadTools()
 * (ToolEntry.requireConfirm) and listTools() (ToolDescriptor.requireConfirm).
 * AC-02 / AC-13.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import {
  listTools,
  _resetToolHandlerCacheForTests,
} from '../src/tools/registry';
import {
  _setSnapshotForTests,
  _resetSnapshotForTests,
} from '../src/plugins/registry';
import { _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-kinds-${process.pid}`;

function mkmanifest(layer: 'L0' | 'L1' | 'L2', dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  return dir;
}

const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

async function reloadFromTmp() {
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
  return kinds;
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

describe('kind dispatcher', () => {
  it('extracts workbench entry with position/standalone/panelSize', async () => {
    mkmanifest('L0', 'wb-test', {
      id: '@forgeax-plugin/wb-test',
      kind: 'workbench',
      displayName: { zh: 'wb' },
      provides: { workbench: { id: 'test', position: 110, panelSize: 'lg' } },
      entry: { standalone: { port: 5173 } },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.workbench.length).toBe(1);
    expect(reg.workbench[0]).toMatchObject({
      pluginId: '@forgeax-plugin/wb-test',
      workbenchId: 'test',
      position: 110,
      panelSize: 'lg',
      hasStandalone: true,
    });
  });

  it('normalizes shorthand skill (string entry + leading-slash trigger)', async () => {
    mkmanifest('L0', 'skill-x', {
      id: '@forgeax-plugin/skill-x',
      kind: 'skill',
      displayName: { zh: 'skill' },
      provides: { skills: [{ id: 'foo', entry: './SKILL.md', trigger: '/foo' }] },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.skills.length).toBe(1);
    expect(reg.skills[0].definition.entry).toEqual({ kind: 'prompt', file: './SKILL.md' });
    expect(reg.skills[0].definition.triggers).toEqual([{ kind: 'slash', command: 'foo' }]);
  });

  it('flags agent missing personaFile but still registers definition', async () => {
    mkmanifest('L0', 'agent-x', {
      id: '@forgeax-plugin/agent-x',
      kind: 'agent',
      displayName: { zh: 'agent' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
        },
      },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.agents.length).toBe(1);
    expect(reg.agents[0].definition.id).toBe('iori');
    expect(reg.issues.some((i) => i.kind === 'agent')).toBe(true);
  });

  it('skill discovery works inside a workbench-kind plugin', async () => {
    mkmanifest('L0', 'wb-with-skills', {
      id: '@forgeax-plugin/wb-with-skills',
      kind: 'workbench',
      displayName: { zh: 'wb' },
      provides: {
        workbench: { id: 'ws' },
        skills: [{ id: 'inner', entry: './SKILL.md' }],
      },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.workbench.length).toBe(1);
    expect(reg.skills.length).toBe(1);
    expect(reg.skills[0].definition.id).toBe('inner');
  });

  it('sorts workbench by position then id', async () => {
    mkmanifest('L0', 'wb-late', {
      id: '@forgeax-plugin/wb-late',
      kind: 'workbench',
      displayName: { zh: 'late' },
      provides: { workbench: { id: 'late', position: 200 } },
    });
    mkmanifest('L0', 'wb-early', {
      id: '@forgeax-plugin/wb-early',
      kind: 'workbench',
      displayName: { zh: 'early' },
      provides: { workbench: { id: 'early', position: 100 } },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.workbench.map((w) => w.workbenchId)).toEqual(['early', 'late']);
  });
});

// w3: AC-02 / AC-13 — requireConfirm three-value enum pass-through
describe('loadTools requireConfirm enum pass-through (AC-02)', () => {
  it('passes requireConfirm:destructive from manifest through ToolEntry', async () => {
    mkmanifest('L1', 'rc-destructive', {
      id: '@x/rc-destructive',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      provides: {
        tools: [{ id: 'rd.del', exposedToAI: true, requireConfirm: 'destructive' }],
      },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'rd.del')!;
    expect(entry).toBeDefined();
    // This assertion fails before w4 because ToolEntry.requireConfirm is boolean
    expect(entry.requireConfirm).toBe('destructive');
  });

  it('passes requireConfirm:never through ToolEntry', async () => {
    mkmanifest('L1', 'rc-never', {
      id: '@x/rc-never',
      kind: 'tool',
      displayName: { zh: 'n', en: 'n' },
      provides: { tools: [{ id: 'rn.t', requireConfirm: 'never' }] },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'rn.t')!;
    expect(entry).toBeDefined();
    expect(entry.requireConfirm).toBe('never');
  });

  it('passes requireConfirm:undefined (omitted) through ToolEntry', async () => {
    mkmanifest('L1', 'rc-omit', {
      id: '@x/rc-omit',
      kind: 'tool',
      displayName: { zh: 'o', en: 'o' },
      provides: { tools: [{ id: 'ro.t' }] },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'ro.t')!;
    expect(entry).toBeDefined();
    // undefined (no value) is the correct state when manifest omits requireConfirm
    expect(entry.requireConfirm).toBeUndefined();
  });
});

// w3: AC-13 — listTools() ToolDescriptor contains requireConfirm field
describe('listTools ToolDescriptor requireConfirm (AC-13)', () => {
  it('ToolDescriptor.requireConfirm is destructive when manifest declares it', async () => {
    mkmanifest('L1', 'desc-destructive', {
      id: '@x/desc-destructive',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      provides: {
        tools: [{ id: 'dd.del', exposedToAI: true, requireConfirm: 'destructive' }],
      },
    });
    await reloadFromTmp();
    const list = listTools();
    const desc = list.find((t) => t.id === 'dd.del')!;
    expect(desc).toBeDefined();
    // This assertion fails before w4 because ToolDescriptor.requireConfirm is boolean
    expect(desc.requireConfirm).toBe('destructive');
  });

  it('ToolDescriptor.requireConfirm is undefined when manifest omits field', async () => {
    mkmanifest('L1', 'desc-omit', {
      id: '@x/desc-omit',
      kind: 'tool',
      displayName: { zh: 'o', en: 'o' },
      provides: { tools: [{ id: 'do.t' }] },
    });
    await reloadFromTmp();
    const list = listTools();
    const desc = list.find((t) => t.id === 'do.t')!;
    expect(desc).toBeDefined();
    expect(desc.requireConfirm).toBeUndefined();
  });
});
