/**
 * w8: POST /api/tools/confirm integration tests (RED before w11).
 *
 * Tests that the /api/tools/confirm endpoint accepts {token, decision}
 * and resolves a pending callTool via the event bus. Also verifies that
 * invalid bodies return 400.
 *
 * AC-10: POST {token, decision} -> 200 -> callTool resolves ok:true
 * D-8:  missing token or invalid decision -> 400
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import {
  _setSnapshotForTests,
  _resetSnapshotForTests,
} from '../src/plugins/registry';
import { callTool, _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { createToolsRouter } from '../src/api/tools';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-confirm-api-${process.pid}`;

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

function makeApp() {
  const app = new Hono();
  app.route('/api/tools', createToolsRouter());
  return app;
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

describe('POST /api/tools/confirm (w8 AC-10)', () => {
  it('allows a pending callTool via token+decision:allow (AC-10)', async () => {
    const dir = mkmanifest('L1', 'api-allow', {
      id: '@x/api-allow',
      kind: 'tool',
      displayName: { zh: 'aa', en: 'aa' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'aa.go', exposedToAI: true, requireConfirm: 'always' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'aa.go': async () => 'api-ok' };\n`, 'utf-8');
    await reloadFromTmp();

    const bus = getEventBus();
    let capturedToken: string | null = null;
    bus.subscribe('tool.confirm-required', (e) => {
      capturedToken = (e.payload as { token?: string }).token ?? null;
    });

    // Start callTool — it will block waiting for ack
    const pending = callTool({ toolId: 'aa.go', args: {}, caller: { kind: 'ai' } });
    // Wait for emit
    await new Promise((r) => setTimeout(r, 20));

    // POST /api/tools/confirm with token (not confirmId)
    const app = makeApp();
    const res = await app.request('/api/tools/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Before w11, the endpoint uses confirmId; this test fails because token field is ignored
      body: JSON.stringify({ token: capturedToken, decision: 'allow' }),
    });
    expect(res.status).toBe(200);

    const r = await pending;
    expect(r).toEqual({ ok: true, result: 'api-ok' });
  });

  it('returns 400 when token field is missing (D-8)', async () => {
    const app = makeApp();
    const res = await app.request('/api/tools/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // token missing — old schema used confirmId; new schema requires token
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when decision is invalid value (D-8)', async () => {
    const app = makeApp();
    const res = await app.request('/api/tools/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'confirm-foo-123-abc', decision: 'maybe' }),
    });
    // Before w11, body schema uses confirmId not token; 'maybe' decision may or may not trigger 400
    // After w11: z.enum(['allow','deny']) rejects 'maybe' -> 400
    expect(res.status).toBe(400);
  });

  it('returns 400 when old confirmId field used instead of token (D-8 regression)', async () => {
    const app = makeApp();
    const res = await app.request('/api/tools/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Old-style body with confirmId: should return 400 after w11 migration
      body: JSON.stringify({ confirmId: 'some-uuid', decision: 'allow' }),
    });
    // Before w11: old code checks confirmId -> returns 200 (RED — the test expects 400)
    // After w11: new schema z.object({token, decision}) -> missing token -> 400 (GREEN)
    expect(res.status).toBe(400);
  });

  it('POST deny via token resolves callTool with user-rejected (AC-10 deny path)', async () => {
    const dir = mkmanifest('L1', 'api-deny', {
      id: '@x/api-deny',
      kind: 'tool',
      displayName: { zh: 'ad', en: 'ad' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'ad.go', exposedToAI: true, requireConfirm: 'destructive' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'ad.go': async () => 'should-not-run' };\n`, 'utf-8');
    await reloadFromTmp();

    const bus = getEventBus();
    let capturedToken: string | null = null;
    bus.subscribe('tool.confirm-required', (e) => {
      capturedToken = (e.payload as { token?: string }).token ?? null;
    });

    const pending = callTool({ toolId: 'ad.go', args: {}, caller: { kind: 'ai' } });
    await new Promise((r) => setTimeout(r, 20));

    const app = makeApp();
    await app.request('/api/tools/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: capturedToken, decision: 'deny' }),
    });

    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Before w11: returns denied_by_user (RED — expects user-rejected)
      // After w11+w10: returns user-rejected (GREEN)
      expect(r.code).toBe('user-rejected');
    }
  });
});
