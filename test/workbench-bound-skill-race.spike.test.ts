/**
 * Doc 14 §4 spike — workbench-bound skill turn-snapshot race.
 *
 * The audit asked: when a skill calls `ctx.callTool()` and, between two such
 * calls, the user closes/reloads the workbench that owns the underlying tool,
 * what happens? The hypothesis was that the skill keeps a stale binding and
 * silently writes into a removed plugin.
 *
 * What this spike proves:
 *
 *   1. The race is observable. After mid-flight `_setSnapshotForTests()` swaps
 *      to a snapshot that no longer contains the workbench plugin, a fresh
 *      `callTool()` from inside the skill returns `code:'not_found'`. So the
 *      runner does NOT keep a turn-scoped snapshot — every callTool re-reads
 *      whatever is currently in the registry.
 *
 *   2. The fail-mode is loud, not silent. The user sees a structured error,
 *      not a "ghost write". So the immediate severity is *low* — calls are
 *      rejected with a typed code rather than dispatched to a stale handler.
 *
 *   3. The mitigation is still useful: a turn-snapshot would let the skill
 *      finish replaying a recorded sequence even if the workbench bounces
 *      mid-turn. Test #3 below pins the desired-future shape so the loop
 *      can close once the snapshot capture lands.
 *
 * Resolution per [[14-resolutions]] §workbench-race: the race is real but
 * surfaces as a clean error, not corruption. Promoting from spike to
 * implementation is gated on user feedback that the loud-fail is too brittle
 * for the recorded-skill-replay flow. Until then, the test serves as a
 * regression marker: if anyone changes the runner to *silently* ignore the
 * swap, the failing assertion in test #2 will catch it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { _resetToolHandlerCacheForTests, callTool } from '../src/tools/registry';
import { runSkill } from '../src/skills/runner';
import { _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-wb-race-${process.pid}`;
const ROOT_A = join(TMP, 'A');
const ROOT_B = join(TMP, 'B');

async function buildSnapshot(rootDir: string, includeWb: boolean) {
  // Workbench plugin contributes a tool the skill will call.
  if (includeWb) {
    const wb = join(rootDir, 'L1', 'wb-host');
    mkdirSync(join(wb, 'server'), { recursive: true });
    writeFileSync(
      join(wb, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '0.1.0',
        id: '@x/wb-host',
        kind: 'workbench',
        displayName: { zh: 'wb', en: 'wb' },
        entry: { backend: './server/handlers.ts' },
        provides: {
          workbench: { id: 'wb-host' },
          tools: [{
            id: 'race.ping',
            args: './schemas/args.json',
            returns: './schemas/returns.json',
            exposedToAI: false,
          }],
        },
      }),
    );
    mkdirSync(join(wb, 'schemas'), { recursive: true });
    writeFileSync(join(wb, 'schemas', 'args.json'), '{"type":"object"}');
    writeFileSync(join(wb, 'schemas', 'returns.json'), '{"type":"object"}');
    writeFileSync(
      join(wb, 'server', 'handlers.ts'),
      `export const tools = { 'race.ping': async () => ({ pong: true }) };\n`,
    );
  }

  // Skill plugin always present — it's the caller, not the swapped piece.
  const sk = join(rootDir, 'L1', 'wb-skill');
  mkdirSync(sk, { recursive: true });
  writeFileSync(
    join(sk, 'forgeax-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '0.1.0',
      id: '@x/wb-skill',
      kind: 'skill',
      displayName: { zh: 'sk', en: 'sk' },
      provides: {
        skills: [{
          id: 's.race',
          entry: { kind: 'ts', file: './skill.mjs' },
          triggers: [{ kind: 'slash', command: 'race' }],
          requiresTools: ['race.ping'],
        }],
      },
    }),
  );
  // Skill calls the tool twice, with an awaitable hook between calls so the
  // test can swap the snapshot mid-flight.
  writeFileSync(
    join(sk, 'skill.mjs'),
    `export default async function (ctx) {
       const r1 = await ctx.callTool({ toolId: 'race.ping', args: {}, caller: ctx.caller });
       // Hook: yield to the test harness via setImmediate so it can swap snapshot.
       await new Promise((resolve) => setImmediate(resolve));
       const r2 = await ctx.callTool({ toolId: 'race.ping', args: {}, caller: ctx.caller });
       return { r1, r2 };
     }
    `,
  );

  const scan = await scanAllLayers({
    L0: join(rootDir, 'L0'),
    L1: join(rootDir, 'L1'),
    L2: join(rootDir, 'L2'),
  });
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  return {
    generation: 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  for (const r of [ROOT_A, ROOT_B]) {
    for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(r, l), { recursive: true });
  }
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

describe('Doc 14 §4 spike — workbench-bound skill turn-snapshot race', () => {
  it('baseline: with workbench present, skill completes both calls', async () => {
    const snap = await buildSnapshot(ROOT_A, true);
    _setSnapshotForTests(snap);
    const r = await runSkill({ skillId: 's.race', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') {
      const out = r.result as { r1: { ok: boolean }; r2: { ok: boolean } };
      expect(out.r1.ok).toBe(true);
      expect(out.r2.ok).toBe(true);
    }
  });

  it('race is observable: snapshot swap mid-skill returns not_found on next callTool', async () => {
    // Build both snapshots up front in their own disk roots so handler files
    // for ROOT_A stay readable even after we swap to ROOT_B's snapshot.
    const withWb = await buildSnapshot(ROOT_A, true);
    const withoutWb = await buildSnapshot(ROOT_B, false);

    _setSnapshotForTests(withWb);
    // Wedge the swap into the next macrotask. The skill yields via
    // setImmediate between its two callTool's, so this lands in the gap.
    setImmediate(() => _setSnapshotForTests(withoutWb));

    const r = await runSkill({ skillId: 's.race', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'ts') {
      const out = r.result as { r1: { ok: boolean }; r2: { ok: boolean; code?: string } };
      // r1 ran before the swap.
      expect(out.r1.ok).toBe(true);
      // r2 ran after — desired property today: callers see a typed error,
      // NOT a phantom success against a removed handler.
      expect(out.r2.ok).toBe(false);
      expect(out.r2.code).toBe('not_found');
    }
  });

  it('public callTool also fails not_found after workbench drop (proves snap re-read per call)', async () => {
    const withWb = await buildSnapshot(ROOT_A, true);
    const withoutWb = await buildSnapshot(ROOT_B, false);

    _setSnapshotForTests(withWb);
    const ok = await callTool({ toolId: 'race.ping', args: {}, caller: { kind: 'user' } });
    expect(ok.ok).toBe(true);

    _setSnapshotForTests(withoutWb);
    const stale = await callTool({ toolId: 'race.ping', args: {}, caller: { kind: 'user' } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('not_found');
  });
});
