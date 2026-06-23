/**
 * Phase C3 — cli-provider kind loader tests. Builds /tmp manifests and
 * exercises both the registry pass-through (loadCliProvider) and the lazy
 * driver materialization helper (loadDriverForEntry).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { loadDriverForEntry } from '../src/plugins/kinds/cli-provider';
import {
  registerDriver,
  unregisterDriver,
  _resetDriverRegistryForTests,
  type Driver,
} from '@forgeax/agent-runtime';

const TMP = `/tmp/forgeax-cli-provider-kind-${process.pid}`;

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

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetDriverRegistryForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetDriverRegistryForTests();
});

function fakeDriver(id: string): Driver {
  return {
    id,
    name: id,
    selfContained: true,
    async chat() {
      return {
        async *[Symbol.asyncIterator]() { yield { kind: 'done' as const }; },
        async cancel() {},
      };
    },
    async health() { return { ok: true, name: id }; },
  };
}

describe('cli-provider kind loader', () => {
  it('extracts CliProviderEntry from manifest', async () => {
    mkmanifest('L0', 'cp-x', {
      id: '@forgeax-plugin/cp-x',
      kind: 'cli-provider',
      displayName: { zh: '某 CLI', en: 'Some CLI' },
      provides: {
        cliProvider: {
          id: 'some-cli',
          displayName: 'Some CLI Display',
          models: ['m1', 'm2'],
          capabilities: { streaming: true, toolCalls: true },
        },
      },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.cliProviders.length).toBe(1);
    expect(reg.cliProviders[0]).toMatchObject({
      pluginId: '@forgeax-plugin/cp-x',
      providerId: 'some-cli',
      displayName: 'Some CLI Display',
      models: ['m1', 'm2'],
      capabilities: { streaming: true, toolCalls: true },
      backendPath: null,
    });
  });

  it('falls back to manifest.displayName.zh when cliProvider.displayName missing', async () => {
    mkmanifest('L0', 'cp-fb', {
      id: '@forgeax-plugin/cp-fb',
      kind: 'cli-provider',
      displayName: { zh: '中文名', en: 'EN' },
      provides: { cliProvider: { id: 'fb-cli' } },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.cliProviders[0].displayName).toBe('中文名');
  });

  it('records backendPath when entry.backend is set', async () => {
    const dir = mkmanifest('L0', 'cp-bk', {
      id: '@forgeax-plugin/cp-bk',
      kind: 'cli-provider',
      displayName: { zh: 'bk' },
      entry: { backend: './driver.ts' },
      provides: { cliProvider: { id: 'bk-cli' } },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    expect(reg.cliProviders[0].backendPath).toBe(join(dir, 'driver.ts'));
  });

  it('loadDriverForEntry returns already-registered in-tree driver', async () => {
    mkmanifest('L0', 'cp-native', {
      id: '@forgeax-plugin/cp-native',
      kind: 'cli-provider',
      displayName: { zh: 'native' },
      provides: { cliProvider: { id: 'forgeax-native' } },
    });
    const native = fakeDriver('forgeax-native');
    registerDriver(native);

    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    const r = await loadDriverForEntry(reg.cliProviders[0]);
    expect(r.driver).toBe(native);
  });

  it('loadDriverForEntry caches the resolved driver', async () => {
    mkmanifest('L0', 'cp-cache', {
      id: '@forgeax-plugin/cp-cache',
      kind: 'cli-provider',
      displayName: { zh: 'c' },
      provides: { cliProvider: { id: 'c-cli' } },
    });
    const d1 = fakeDriver('c-cli');
    registerDriver(d1);
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    const entry = reg.cliProviders[0];
    const a = await loadDriverForEntry(entry);
    // Swap registry — cache should still return the original.
    unregisterDriver('c-cli');
    registerDriver(fakeDriver('c-cli'));
    const b = await loadDriverForEntry(entry);
    expect(a.driver).toBe(b.driver);
    expect(a.driver).toBe(d1);
  });

  it('loadDriverForEntry imports entry.backend when no in-tree driver', async () => {
    const dir = mkmanifest('L0', 'cp-imp', {
      id: '@forgeax-plugin/cp-imp',
      kind: 'cli-provider',
      displayName: { zh: 'imp' },
      entry: { backend: './driver.ts' },
      provides: { cliProvider: { id: 'imported-cli' } },
    });
    writeFileSync(
      join(dir, 'driver.ts'),
      `export default {
        id: 'imported-cli',
        name: 'Imported',
        selfContained: true,
        async chat() {
          return {
            [Symbol.asyncIterator]: async function*() { yield { kind: 'done' }; },
            cancel: async () => {},
          };
        },
        async health() { return { ok: true, name: 'imported-cli' }; },
      };`,
      'utf-8',
    );
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    const r = await loadDriverForEntry(reg.cliProviders[0]);
    expect(r.driver?.id).toBe('imported-cli');
  });

  it('loadDriverForEntry returns reason when no backend + no in-tree', async () => {
    mkmanifest('L0', 'cp-miss', {
      id: '@forgeax-plugin/cp-miss',
      kind: 'cli-provider',
      displayName: { zh: 'm' },
      provides: { cliProvider: { id: 'missing-cli' } },
    });
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    const r = await loadDriverForEntry(reg.cliProviders[0]);
    expect(r.driver).toBeNull();
    expect(r.reason).toContain('no entry.backend');
  });

  it('loadDriverForEntry rejects when imported driver.id mismatches manifest', async () => {
    const dir = mkmanifest('L0', 'cp-mis', {
      id: '@forgeax-plugin/cp-mis',
      kind: 'cli-provider',
      displayName: { zh: 'mis' },
      entry: { backend: './driver.ts' },
      provides: { cliProvider: { id: 'expected-id' } },
    });
    writeFileSync(
      join(dir, 'driver.ts'),
      `export default {
        id: 'wrong-id',
        name: 'wrong',
        selfContained: true,
        async chat() { return { [Symbol.asyncIterator]: async function*() {}, cancel: async () => {} }; },
        async health() { return { ok: true, name: 'wrong-id' }; },
      };`,
      'utf-8',
    );
    const merged = mergeManifests((await scanAllLayers(ROOTS())).found);
    const reg = buildKindRegistry(merged.manifests);
    const r = await loadDriverForEntry(reg.cliProviders[0]);
    expect(r.driver).toBeNull();
    expect(r.reason).toMatch(/wrong-id.*expected-id/);
  });
});
