/**
 * Doc 04 §triggers — `{kind:'event'}` runtime. Skills can declare
 * `triggers: [{ kind: 'event', topic: 'tool.completed' }]` and the bridge
 * subscribes them to the bus on snapshot load. This test covers:
 *   1) the bridge subscribes from a snapshot,
 *   2) firing a matching event invokes runSkill,
 *   3) re-syncing replaces the previous bindings (no leaks),
 *   4) the input passed to the skill includes the triggering event envelope,
 *   5) the bridge tolerates skill failures without unbinding.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';
import { syncEventTriggerBindings, _resetEventBridgeForTests } from '../src/skills/event-bridge';

const TMP = `/tmp/forgeax-skill-event-${process.pid}`;
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
  _resetEventBridgeForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetEventBusForTests();
  _resetEventBridgeForTests();
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

describe('skill event-trigger bridge', () => {
  it('subscribes one binding per event-trigger and surfaces stats', async () => {
    const dir = writeManifest('ev', {
      id: '@x/ev',
      kind: 'skill',
      displayName: { zh: 'e', en: 'e' },
      provides: {
        skills: [
          {
            id: 's.on-completed',
            entry: { kind: 'ts', file: './e.mjs' },
            triggers: [{ kind: 'event', topic: 'tool.completed' }],
          },
        ],
      },
    });
    writeFileSync(join(dir, 'e.mjs'), `export default () => 1;\n`, 'utf-8');
    const snap = await buildSnap();
    const stats = syncEventTriggerBindings(snap, getEventBus());
    expect(stats.bindings).toEqual([{ topic: 'tool.completed', skillId: 's.on-completed', pluginId: '@x/ev' }]);
  });

  it('runs the skill when a matching event fires; input.event carries the envelope', async () => {
    const dir = writeManifest('rec', {
      id: '@x/rec',
      kind: 'skill',
      displayName: { zh: 'r', en: 'r' },
      provides: {
        skills: [
          {
            id: 's.record',
            entry: { kind: 'ts', file: './r.mjs' },
            triggers: [{ kind: 'event', topic: 'demo.fire' }],
            // Doc 14 §4 — skill writes a sentinel file, so it must declare
            // fs permissions or the runner's static-import lint refuses to
            // load it.
            permissions: [{ kind: 'fs', mode: 'write', path: '**' }],
          },
        ],
      },
    });
    // Skill writes the event envelope it received into the temp dir so we
    // can assert it landed.
    const sentinel = join(TMP, 'sentinel.json');
    writeFileSync(
      join(dir, 'r.mjs'),
      `import { writeFileSync } from 'node:fs';
       export default async (ctx) => { writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(ctx.input)); return 'k'; };
      `,
      'utf-8',
    );
    const snap = await buildSnap();
    syncEventTriggerBindings(snap, getEventBus());

    // Watch skill.completed so we know when the bridge dispatch finishes.
    const got: string[] = [];
    getEventBus().subscribe('skill.completed', (e) => got.push(e.topic));

    getEventBus().emit('demo.fire', { hello: 'world' }, { threadId: 'th-1' });

    // Wait until skill.completed shows up — the bridge dispatches via runSkill
    // which is async; one microtask is not enough on slow runners.
    const deadline = Date.now() + 1500;
    while (got.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(got.length).toBeGreaterThan(0);

    const written = JSON.parse(await Bun.file(sentinel).text());
    expect(written.event.topic).toBe('demo.fire');
    expect(written.event.payload).toEqual({ hello: 'world' });
    expect(written.event.threadId).toBe('th-1');
  });

  it('re-syncing replaces previous bindings (no double-fire)', async () => {
    const dir = writeManifest('twice', {
      id: '@x/twice',
      kind: 'skill',
      displayName: { zh: 't', en: 't' },
      provides: {
        skills: [
          {
            id: 's.t',
            entry: { kind: 'ts', file: './t.mjs' },
            triggers: [{ kind: 'event', topic: 'replace.me' }],
          },
        ],
      },
    });
    writeFileSync(join(dir, 't.mjs'), `export default () => 1;\n`, 'utf-8');
    const snap = await buildSnap();
    syncEventTriggerBindings(snap, getEventBus());
    // Sync twice — the bridge must NOT end up with two listeners.
    syncEventTriggerBindings(snap, getEventBus());

    let fires = 0;
    getEventBus().subscribe('skill.starting', () => { fires += 1; });
    getEventBus().emit('replace.me', {});
    const deadline = Date.now() + 1500;
    while (fires === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Allow a small settle window in case a leaked binding queues a second
    // skill run.
    await new Promise((r) => setTimeout(r, 50));
    expect(fires).toBe(1);
  });

  it('a skill that throws at import-time does NOT take the bridge down', async () => {
    const dir = writeManifest('crash', {
      id: '@x/crash',
      kind: 'skill',
      displayName: { zh: 'c', en: 'c' },
      provides: {
        skills: [
          {
            id: 's.crash',
            entry: { kind: 'ts', file: './crash.mjs' },
            triggers: [{ kind: 'event', topic: 'boom' }],
          },
          {
            id: 's.ok',
            entry: { kind: 'ts', file: './ok.mjs' },
            triggers: [{ kind: 'event', topic: 'boom' }],
          },
        ],
      },
    });
    writeFileSync(join(dir, 'crash.mjs'), `throw new Error('import fail');\n`, 'utf-8');
    writeFileSync(join(dir, 'ok.mjs'), `export default () => 'ok';\n`, 'utf-8');
    const snap = await buildSnap();
    syncEventTriggerBindings(snap, getEventBus());

    const completed: string[] = [];
    getEventBus().subscribe('skill.completed', (e) => completed.push((e.payload as { skillId: string }).skillId));
    getEventBus().emit('boom', {});
    const deadline = Date.now() + 1500;
    while (completed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completed).toContain('s.ok');
  });
});
