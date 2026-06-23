/**
 * Phase D6 (2/4) — fork backend.
 *
 * The fork helper does three things, in order: copy src tree → patch manifest
 * id + displayName → leave the registry stale (caller calls reloadPlugins).
 * These tests pin all three on a tmp-rooted fixture so we don't pollute the
 * real ~/.forgeax/plugins/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { forkPlugin, defaultForkId } from '../src/plugins/fork';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';

const TMP = `/tmp/forgeax-fork-${process.pid}`;

async function reload(L1Root?: string, L2Root?: string): Promise<void> {
  const scan = await scanAllLayers({
    L0: join(TMP, 'L0'),
    L1: L1Root ?? join(TMP, 'L1'),
    L2: L2Root ?? join(TMP, 'L2'),
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

function writeSrc(root: string, dirName: string, body: Record<string, unknown>): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  // Add a stray asset so the recursive copy is exercised.
  writeFileSync(join(dir, 'README.md'), '# original\n', 'utf-8');
  return dir;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
});

describe('plugin fork', () => {
  it('defaultForkId appends -mine; -mine→-2 to avoid -mine-mine', () => {
    expect(defaultForkId('@x/foo')).toBe('@x/foo-mine');
    expect(defaultForkId('@x/foo-mine')).toBe('@x/foo-mine-2');
  });

  it('happy path: copies tree to L2 and patches manifest id + displayName', async () => {
    writeSrc(join(TMP, 'L0'), 'src', {
      id: '@me/src',
      kind: 'tool',
      displayName: { en: 'Src', zh: '原版' },
      entry: { backend: './h.ts' },
      provides: { tools: [{ id: 's.t' }] },
    });
    await reload();
    const r = await forkPlugin({ srcId: '@me/src', newId: '@me/src-fork', destLayer: 'L2', projectRoot: TMP });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe('@me/src-fork');
    expect(r.dir).toBe(join(TMP, '.forgeax/plugins/src-fork'));

    const manifest = JSON.parse(readFileSync(join(r.dir, 'forgeax-plugin.json'), 'utf-8'));
    expect(manifest.id).toBe('@me/src-fork');
    expect(manifest.displayName.en).toContain('(我的)');
    expect(manifest.displayName.zh).toContain('(我的)');
    // Recursive copy carried side files.
    expect(existsSync(join(r.dir, 'README.md'))).toBe(true);
  });

  it('refuses when newId already exists in snapshot', async () => {
    writeSrc(join(TMP, 'L0'), 'a', {
      id: '@me/a',
      kind: 'tool',
      displayName: { en: 'A' },
      entry: { backend: './h.ts' },
      provides: { tools: [{ id: 'a.t' }] },
    });
    writeSrc(join(TMP, 'L0'), 'b', {
      id: '@me/b',
      kind: 'tool',
      displayName: { en: 'B' },
      entry: { backend: './h.ts' },
      provides: { tools: [{ id: 'b.t' }] },
    });
    await reload();
    const r = await forkPlugin({ srcId: '@me/a', newId: '@me/b', destLayer: 'L2', projectRoot: TMP });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('exists');
  });

  it('refuses bad newId namespace', async () => {
    writeSrc(join(TMP, 'L0'), 'src', {
      id: '@me/src',
      kind: 'tool',
      displayName: { en: 'Src' },
      entry: { backend: './h.ts' },
      provides: { tools: [{ id: 's.t' }] },
    });
    await reload();
    const r = await forkPlugin({ srcId: '@me/src', newId: 'no-scope', destLayer: 'L2', projectRoot: TMP });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('refuses unknown srcId', async () => {
    await reload();
    const r = await forkPlugin({ srcId: '@nope/nope', destLayer: 'L2', projectRoot: TMP });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
  });

  it('L2 requires projectRoot', async () => {
    writeSrc(join(TMP, 'L0'), 'src', {
      id: '@me/src',
      kind: 'tool',
      displayName: { en: 'Src' },
      entry: { backend: './h.ts' },
      provides: { tools: [{ id: 's.t' }] },
    });
    await reload();
    const r = await forkPlugin({ srcId: '@me/src', destLayer: 'L2' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });
});
