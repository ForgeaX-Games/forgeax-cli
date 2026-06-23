/**
 * Phase D6 (1/4) — meta:author-plugin discovery + dispatch contract.
 *
 * Mirrors the real marketplace plugin at
 *   packages/marketplace/plugins/skill-author-plugin/
 * into a /tmp scratch L1 root and verifies:
 *   1. The skill is registered with id `meta:author-plugin` and slash trigger
 *      `/author-plugin`.
 *   2. SkillRunner returns the SKILL.md text body verbatim (prompt-entry).
 *   3. listSkills surfaces the i18n displayName + description.
 *
 * We use a /tmp copy rather than scanning the actual marketplace path to keep
 * the snapshot deterministic — but the manifest + SKILL.md body are the SAME
 * files (copied in via copyFileSync at test start).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { runSkill, listSkills } from '../src/skills/runner';
import { _resetEventBusForTests } from '../src/events/bus';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const TMP = `/tmp/forgeax-skill-author-${process.pid}`;
const PLUGIN_DIR = join(TMP, 'L1', 'skill-author-plugin');
const SRC_DIR = resolve(REPO_ROOT, 'packages/marketplace/plugins/skill-author-plugin');

async function reload() {
  const scan = await scanAllLayers({
    L0: join(TMP, 'L0'),
    L1: join(TMP, 'L1'),
    L2: join(TMP, 'L2'),
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
  return { scan, merge, kinds };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  mkdirSync(PLUGIN_DIR, { recursive: true });
  copyFileSync(join(SRC_DIR, 'forgeax-plugin.json'), join(PLUGIN_DIR, 'forgeax-plugin.json'));
  copyFileSync(join(SRC_DIR, 'SKILL.md'), join(PLUGIN_DIR, 'SKILL.md'));
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

describe('skill-author-plugin (meta:author-plugin)', () => {
  it('manifest scans cleanly with no errors or merge issues', async () => {
    const { scan, merge } = await reload();
    expect(scan.errors).toEqual([]);
    expect(merge.issues).toEqual([]);
    const ids = merge.manifests.map((m) => (m as { manifest: { id: string } }).manifest.id);
    expect(ids).toContain('@forgeax-plugin/skill-author-plugin');
  });

  it('listSkills surfaces meta:author-plugin with /author-plugin slash trigger', async () => {
    await reload();
    const skills = listSkills();
    const s = skills.find((x) => x.id === 'meta:author-plugin');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('prompt');
    expect(s!.triggers).toEqual([{ kind: 'slash', command: 'author-plugin' }]);
    // i18n displayName / description echo through.
    const dn = s!.displayName as { en?: string; zh?: string } | undefined;
    expect(dn?.en).toBe('Plugin Author Guide');
    expect(dn?.zh).toBe('插件作者向导');
  });

  it('runSkill returns the SKILL.md body for /author-plugin', async () => {
    await reload();
    const r = await runSkill({ skillId: 'meta:author-plugin', caller: { kind: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'prompt') {
      // Anchor on a couple of unique strings the SKILL.md file is supposed to
      // contain. Don't pin the whole body — that would couple the test to
      // copy-edits.
      expect(r.text).toContain('/author-plugin');
      expect(r.text).toContain('forgeax-plugin.json');
      expect(r.text).toContain('hello:say');
    } else {
      throw new Error(`expected prompt result, got ${JSON.stringify(r)}`);
    }
  });
});
