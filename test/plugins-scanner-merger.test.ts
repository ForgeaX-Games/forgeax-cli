/**
 * Phase B1 unit tests for scanner+merger. Builds disposable plugin trees in
 * /tmp and verifies the L2>L1>L0 override + topo + zod rejection paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';

const TMP = `/tmp/forgeax-plugins-${process.pid}`;

function mkplugin(layer: 'L0' | 'L1' | 'L2', id: string, body: Record<string, unknown>): void {
  const layerDir = join(TMP, layer, id.replace(/^@[^/]+\//, ''));
  mkdirSync(layerDir, { recursive: true });
  writeFileSync(
    join(layerDir, 'forgeax-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: '0.1.0',
      kind: 'workbench',
      displayName: { zh: id },
      ...body,
    }),
    'utf-8',
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

describe('scanner + merger', () => {
  it('finds manifests in each layer', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-a', { provides: { workbench: { id: 'a' } } });
    mkplugin('L1', '@forgeax-plugin/wb-b', { provides: { workbench: { id: 'b' } } });
    mkplugin('L2', '@forgeax-plugin/wb-c', { provides: { workbench: { id: 'c' } } });
    const r = await scanAllLayers(ROOTS());
    expect(r.errors.length).toBe(0);
    expect(r.found.map((f) => f.layer).sort()).toEqual(['L0', 'L1', 'L2']);
  });

  it('follows symlinked plugin directories in L1', async () => {
    mkplugin('L2', '@forgeax-plugin/wb-linked', { provides: { workbench: { id: 'linked' } } });
    const target = join(TMP, 'L2', 'wb-linked');
    rmSync(join(TMP, 'L2', 'wb-linked'), { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-plugin/wb-linked',
        version: '0.1.0',
        kind: 'workbench',
        displayName: { zh: 'linked' },
        provides: { workbench: { id: 'linked' } },
      }),
      'utf-8',
    );
    symlinkSync(target, join(TMP, 'L1', 'wb-linked'), 'dir');

    const r = await scanAllLayers({ ...ROOTS(), L2: null });
    expect(r.errors).toEqual([]);
    expect(r.found.map((f) => [f.layer, f.manifest.id])).toEqual([
      ['L1', '@forgeax-plugin/wb-linked'],
    ]);
  });

  it('rejects malformed manifest with a structured error', async () => {
    mkdirSync(join(TMP, 'L0', 'broken'), { recursive: true });
    writeFileSync(join(TMP, 'L0', 'broken', 'forgeax-plugin.json'), '{not json', 'utf-8');
    const r = await scanAllLayers(ROOTS());
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].layer).toBe('L0');
  });

  it('L2 wins over L1 wins over L0 with shadowedBy chain', async () => {
    const id = '@forgeax-plugin/wb-shared';
    mkplugin('L0', id, { version: '0.1.0', provides: { workbench: { id: 'shared' } } });
    mkplugin('L1', id, { version: '0.2.0', provides: { workbench: { id: 'shared' } } });
    mkplugin('L2', id, { version: '0.3.0', provides: { workbench: { id: 'shared' } } });
    const scan = await scanAllLayers(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.manifests.length).toBe(1);
    expect(merged.manifests[0].layer).toBe('L2');
    expect(merged.manifests[0].manifest.version).toBe('0.3.0');
    expect(merged.manifests[0].shadowedBy.map((s) => s.layer)).toEqual(['L1', 'L0']);
  });

  it('topologically sorts by dependencies (deps before dependents)', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-base', { provides: { workbench: { id: 'base' } } });
    mkplugin('L0', '@forgeax-plugin/wb-mid', {
      provides: { workbench: { id: 'mid' } },
      dependencies: [{ id: '@forgeax-plugin/wb-base' }],
    });
    mkplugin('L0', '@forgeax-plugin/wb-top', {
      provides: { workbench: { id: 'top' } },
      dependencies: [{ id: '@forgeax-plugin/wb-mid' }],
    });
    const scan = await scanAllLayers(ROOTS());
    const merged = mergeManifests(scan.found);
    const order = merged.manifests.map((m) => m.manifest.id);
    expect(order.indexOf('@forgeax-plugin/wb-base'))
      .toBeLessThan(order.indexOf('@forgeax-plugin/wb-mid'));
    expect(order.indexOf('@forgeax-plugin/wb-mid'))
      .toBeLessThan(order.indexOf('@forgeax-plugin/wb-top'));
    expect(merged.issues.length).toBe(0);
  });

  it('reports unknown-dependency without dropping the plugin', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-orphan', {
      provides: { workbench: { id: 'orphan' } },
      dependencies: [{ id: '@forgeax-plugin/missing' }],
    });
    const scan = await scanAllLayers(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'unknown-dependency')).toBe(true);
    expect(merged.manifests.map((m) => m.manifest.id)).toContain('@forgeax-plugin/wb-orphan');
  });

  it('detects dependency cycles', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-x', {
      provides: { workbench: { id: 'x' } },
      dependencies: [{ id: '@forgeax-plugin/wb-y' }],
    });
    mkplugin('L0', '@forgeax-plugin/wb-y', {
      provides: { workbench: { id: 'y' } },
      dependencies: [{ id: '@forgeax-plugin/wb-x' }],
    });
    const scan = await scanAllLayers(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('FORGEAX_SAFE_BOOT=1 skips L1+L2 scans (Doc 14 §4 spike)', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-l0', { provides: { workbench: { id: 'l0' } } });
    mkplugin('L1', '@forgeax-plugin/wb-l1', { provides: { workbench: { id: 'l1' } } });
    mkplugin('L2', '@forgeax-plugin/wb-l2', { provides: { workbench: { id: 'l2' } } });
    const prev = process.env.FORGEAX_SAFE_BOOT;
    process.env.FORGEAX_SAFE_BOOT = '1';
    try {
      const r = await scanAllLayers(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.layer)).toEqual(['L0']);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-plugin/wb-l0']);
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_SAFE_BOOT;
      else process.env.FORGEAX_SAFE_BOOT = prev;
    }
  });

  it('rejects entry.standalone.devOnly:true under FORGEAX_NODE_ENV=production', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-dev', {
      provides: { workbench: { id: 'dev' } },
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    mkplugin('L0', '@forgeax-plugin/wb-prod', {
      provides: { workbench: { id: 'prod' } },
      entry: { standalone: { start: 'node prod.js' } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    process.env.FORGEAX_NODE_ENV = 'production';
    try {
      const r = await scanAllLayers(ROOTS());
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-plugin/wb-prod']);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0].reason).toContain('devOnly');
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_NODE_ENV;
      else process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('accepts entry.standalone.devOnly:true outside production', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-dev', {
      provides: { workbench: { id: 'dev' } },
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    delete process.env.FORGEAX_NODE_ENV;
    try {
      const r = await scanAllLayers(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-plugin/wb-dev']);
    } finally {
      if (prev !== undefined) process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('FORGEAX_SAFE_BOOT unset still scans all three layers', async () => {
    mkplugin('L0', '@forgeax-plugin/wb-l0', { provides: { workbench: { id: 'l0' } } });
    mkplugin('L1', '@forgeax-plugin/wb-l1', { provides: { workbench: { id: 'l1' } } });
    mkplugin('L2', '@forgeax-plugin/wb-l2', { provides: { workbench: { id: 'l2' } } });
    const prev = process.env.FORGEAX_SAFE_BOOT;
    delete process.env.FORGEAX_SAFE_BOOT;
    try {
      const r = await scanAllLayers(ROOTS());
      expect(r.found.map((f) => f.layer).sort()).toEqual(['L0', 'L1', 'L2']);
    } finally {
      if (prev !== undefined) process.env.FORGEAX_SAFE_BOOT = prev;
    }
  });
});
