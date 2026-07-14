/**
 * Phase B3 — exercises the /api/plugins router end-to-end (no network).
 * Mounts the router on a Hono app and hits it with `app.request()`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtensionsRouter } from '../src/api/extensions';
import { reloadExtensions, _resetSnapshotForTests } from '../src/extensions/registry';

const TMP = `/tmp/forgeax-registry-${process.pid}`;

function mkmanifest(layer: string, dirName: string, body: Record<string, unknown>): void {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2']) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
});

describe('/api/plugins', () => {
  it('GET /manifests reflects the last loaded snapshot', async () => {
    mkmanifest('L0', 'wb-x', {
      id: '@forgeax-extension/wb-x',
      kind: 'workbench',
      displayName: { zh: 'X' },
      provides: { workbench: { id: 'x', position: 110 } },
    });
    await reloadExtensions({ roots: { L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') } });

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.counts.manifests).toBe(1);
    expect(body.counts.workbench).toBe(1);
    expect(body.manifests[0]).toMatchObject({
      id: '@forgeax-extension/wb-x',
      kind: 'workbench',
      layer: 'L0',
    });
    expect(body.workbench[0]).toMatchObject({ workbenchId: 'x', position: 110 });
  });

  it('POST /reload bumps generation and picks up new on-disk manifests', async () => {
    const roots = { L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') };
    const before = await reloadExtensions({ roots });
    expect(before.manifests.length).toBe(0);

    mkmanifest('L0', 'wb-late', {
      id: '@forgeax-extension/wb-late',
      kind: 'workbench',
      displayName: { zh: 'Late' },
      provides: { workbench: { id: 'late' } },
    });

    // The router doesn't know about our test roots, so reload manually too —
    // we're testing the response-shape contract here, not the directory
    // walker (that's covered in plugins-scanner-merger.test.ts).
    const after = await reloadExtensions({ roots });
    expect(after.generation).toBe(before.generation + 1);
    expect(after.manifests.length).toBe(1);

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    const body = (await res.json()) as any;
    expect(body.generation).toBe(after.generation);
    expect(body.manifests[0].id).toBe('@forgeax-extension/wb-late');
  });

  it('serializes scan errors as issues with phase=scan', async () => {
    mkdirSync(join(TMP, 'L0', 'broken'), { recursive: true });
    writeFileSync(join(TMP, 'L0', 'broken', 'forgeax-extension.json'), '{ malformed', 'utf-8');
    await reloadExtensions({ roots: { L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') } });

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    const body = (await res.json()) as any;
    expect(body.issues.some((i: { phase: string }) => i.phase === 'scan')).toBe(true);
  });
});
