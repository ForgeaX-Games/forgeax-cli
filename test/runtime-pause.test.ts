/**
 * Doc 07 §TopBar Pause — backend gate. The TopBar's "Pause AI" toggle is
 * a UI affordance for halting the agent without killing the user's hands.
 * This test pins the backend half:
 *   1) setPaused(true) blocks AI tool calls with code:'paused'.
 *   2) setPaused(true) blocks AI skill runs with code:'paused'.
 *   3) User-initiated calls remain live while paused.
 *   4) The bus emits runtime.paused / runtime.resumed envelopes.
 *   5) setPaused is idempotent (setting same state twice = no second event).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';
import { setPaused, _resetPauseForTests, isPaused } from '../src/runtime/pause';
import { callTool } from '../src/tools/registry';
import { runSkill } from '../src/skills/runner';

const TMP = `/tmp/forgeax-pause-${process.pid}`;
const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

async function buildSnap() {
  const scan = await scanAllLayers(ROOTS());
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  const snap = {
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
  _resetEventBusForTests();
  _resetPauseForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetEventBusForTests();
  _resetPauseForTests();
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

describe('Doc 07 — runtime pause backend', () => {
  it('emits runtime.paused / runtime.resumed on transitions; idempotent', () => {
    const events: string[] = [];
    getEventBus().subscribe('runtime.*', (e) => events.push(e.topic));

    expect(isPaused()).toBe(false);
    setPaused(true, 'manual');
    expect(isPaused()).toBe(true);
    // Setting the same state again must NOT emit a second event.
    setPaused(true);
    setPaused(false);
    expect(isPaused()).toBe(false);
    setPaused(false); // idempotent

    expect(events).toEqual(['runtime.paused', 'runtime.resumed']);
  });

  it('blocks AI tool calls with code:"paused"; user calls pass through', async () => {
    const dir = writeManifest('t', {
      id: '@x/t',
      kind: 'tool',
      displayName: { zh: 't', en: 't' },
      entry: { backend: './h.mjs' },
      provides: {
        tools: [{ id: 't.echo', exposedToAI: true }],
      },
    });
    writeFileSync(
      join(dir, 'h.mjs'),
      `export default { 't.echo': async () => ({ ok: true }) };\n`,
      'utf-8',
    );
    await buildSnap();

    setPaused(true);
    const ai = await callTool({ toolId: 't.echo', args: {}, caller: { kind: 'ai' } });
    expect(ai.ok).toBe(false);
    if (!ai.ok) expect(ai.code).toBe('paused');

    // User caller is unaffected — Pause means "freeze the agent, not the
    // user's hands".
    const user = await callTool({ toolId: 't.echo', args: {}, caller: { kind: 'user' } });
    expect(user.ok).toBe(true);
  });

  it('blocks AI skill runs with code:"paused"', async () => {
    const dir = writeManifest('s', {
      id: '@x/s',
      kind: 'skill',
      displayName: { zh: 's', en: 's' },
      provides: {
        skills: [{
          id: 's.noop',
          entry: { kind: 'ts', file: './s.mjs' },
        }],
      },
    });
    writeFileSync(join(dir, 's.mjs'), `export default () => 'ok';\n`, 'utf-8');
    await buildSnap();

    setPaused(true);
    const r = await runSkill({ skillId: 's.noop', caller: { kind: 'ai' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('paused');

    const u = await runSkill({ skillId: 's.noop', caller: { kind: 'user' } });
    expect(u.ok).toBe(true);
  });
});
