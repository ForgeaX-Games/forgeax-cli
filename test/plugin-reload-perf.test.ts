/**
 * Doc 11 §performance budget — plugin reload latency.
 *
 * The audit punch-list flags Doc 11's "性能预算 / reload 时长 没基准" as
 * never-actioned. This file establishes the baseline: scanAllLayers +
 * mergeManifests + buildKindRegistry over a synthesized fleet of 50
 * plugins (a generous upper bound for marketplace × user × project) must
 * complete inside the budget.
 *
 * The numbers below are intentionally generous — fast disks finish in
 * single digits of ms; CI runners with cold filesystem caches can push
 * higher. Bumping these is fine when the baseline shifts; the value is
 * having a *test* that fails before the next 10× regression slips in.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';

const TMP = `/tmp/forgeax-perf-${process.pid}`;

const FLEET = 50;
/** Generous deadlines — picked so we catch a 5× regression, not so we
 *  flake on a contended runner. */
const SCAN_BUDGET_MS = 1500;
const FULL_BUDGET_MS = 3000;

function seedFleet(root: string, count: number): void {
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const dir = join(root, `plugin-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '0.1.0',
        id: `@perf/plugin-${i}`,
        kind: 'tool',
        displayName: { zh: `t${i}`, en: `t${i}` },
        provides: {
          tools: [{ id: `perf.t${i}`, exposedToAI: false }],
        },
      }),
      'utf-8',
    );
  }
}

describe('Doc 11 — plugin reload perf budget', () => {
  it(`scanAllLayers + buildKindRegistry over ${FLEET} plugins fits in ${FULL_BUDGET_MS}ms`, async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const roots = {
      L0: join(TMP, 'L0'),
      L1: join(TMP, 'L1'),
      L2: join(TMP, 'L2'),
    };
    for (const r of Object.values(roots)) mkdirSync(r, { recursive: true });
    seedFleet(roots.L1, FLEET);

    try {
      const t0 = performance.now();
      const scan = await scanAllLayers(roots);
      const t1 = performance.now();
      const merge = mergeManifests(scan.found);
      const kinds = buildKindRegistry(merge.manifests);
      const t2 = performance.now();

      // Sanity — make sure we actually loaded what we seeded so the timing
      // isn't measuring an empty walk.
      expect(scan.found.length).toBe(FLEET);
      expect(merge.manifests.length).toBe(FLEET);
      expect(kinds.tools.length).toBe(FLEET);

      const scanMs = t1 - t0;
      const fullMs = t2 - t0;
      // Surface numbers in test output so future regressions are obvious
      // even when the assertion still passes.
      // eslint-disable-next-line no-console
      console.log(`[reload-perf] ${FLEET} plugins · scan=${scanMs.toFixed(1)}ms · full=${fullMs.toFixed(1)}ms`);

      expect(scanMs).toBeLessThan(SCAN_BUDGET_MS);
      expect(fullMs).toBeLessThan(FULL_BUDGET_MS);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});
