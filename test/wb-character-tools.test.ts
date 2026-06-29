/**
 * Phase D3 — wb-character ToolRegistry contract.
 *
 * Verifies the real marketplace plugin manifest at L1 default location:
 *   1. all 11 declared AI-exposed tools land in the snapshot
 *   2. backendPath resolves to ./server/tool-handlers.ts (the new D3 file)
 *   3. callTool dispatches to the actual tool-handlers module
 *   4. unimplemented pipelines surface a structured `not_implemented` error
 *   5. listTools reports `hasHandler: true` for every entry
 *
 * We use a /tmp scratch manifest copy rather than the real marketplace path
 * to keep the snapshot deterministic and avoid pulling in scene-kit etc.,
 * but the manifest body is exactly the same JSON.
 *
 * 解耦后(2026-06):character 业务 SSOT 内聚在本插件 server/character-forge/,
 * tool-handlers 本地 import,manifest 声明全部 16 个 character: 工具(含此前漂移
 * 缺失的 generate-sprite-sheet/pixel/monster/vehicle + save-scene-defaults,以及
 * iframe 客户端管线登记用的 upsert-manifest)。图像生成由宿主经 ctx.imageGen 注入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { callTool, listTools, _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { _resetEventBusForTests } from '../src/events/bus';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const TMP = `/tmp/forgeax-wbc-tools-${process.pid}`;
const PLUGIN_DIR = join(TMP, 'L1', 'wb-character');

const TOOL_IDS = [
  'character:generate-portrait',
  'character:generate-sprite-sheet',
  'character:generate-pixel',
  'character:generate-monster',
  'character:generate-turnaround',
  'character:generate-vehicle',
  'character:list',
  'character:get',
  'character:rename',
  // Doc 01 §P4 funnel tools — internal-only stubs (exposedToAI:false) used
  // when wb-character runs embedded as an iframe.
  'character:save-scene-defaults',
  'character:save-render-config',
  'character:save-spine-session',
  'character:publish-character',
  'character:publish-to-workspace-game',
  'character:merge-skills-to-workspace-game',
  // 客户端管线登记入口(内部,exposedToAI:false);iframe 经 /upsert-manifest 路由代理。
  'character:upsert-manifest',
];

// generate-spine / generate-vfx / generate-video were migrated to wb-skill /
// wb-anim in M1-M2 and removed from the wb-character manifest (M3). The 9
// remaining AI-facing tools are indices 0-8.
const AI_EXPOSED_TOOL_IDS = TOOL_IDS.slice(0, 9);

function mirrorPluginToTmp() {
  mkdirSync(join(PLUGIN_DIR, 'server'), { recursive: true });
  mkdirSync(join(PLUGIN_DIR, 'schemas'), { recursive: true });
  // Copy the live manifest (D3 already updated entry.backend in it).
  const manifestSrc = resolve(REPO_ROOT, 'packages/marketplace/plugins/wb-character/forgeax-plugin.json');
  copyFileSync(manifestSrc, join(PLUGIN_DIR, 'forgeax-plugin.json'));
  // Schema files don't need to exist for ToolRegistry dispatch (they're
  // referenced by argsSchema/returnsSchema as path strings only). Touch
  // them so the kind loader doesn't warn about missing refs.
  for (const id of TOOL_IDS) {
    const base = id.replace(/^character:/, '');
    // `list` and `get` and `rename` use list-characters / get-character / rename-character.
    const slug = base === 'list' ? 'list-characters'
      : base === 'get' ? 'get-character'
      : base === 'rename' ? 'rename-character'
      : base;
    writeFileSync(
      join(PLUGIN_DIR, 'schemas', `${slug}.args.json`),
      JSON.stringify({ type: 'object' }),
    );
    writeFileSync(
      join(PLUGIN_DIR, 'schemas', `${slug}.returns.json`),
      JSON.stringify({ type: 'object' }),
    );
  }
  // Symlink the real tool-handlers.ts under tmp so `import * as forge from
  // '../../../../server/src/lib/character-forge/index'` resolves correctly
  // (the relative path is hard-coded in tool-handlers.ts and assumes the
  // canonical layout). Easier: just write a thin handler file referencing
  // an absolute import via the project's path.
  writeFileSync(
    join(PLUGIN_DIR, 'server', 'tool-handlers.ts'),
    `// scratch copy — points to the in-repo tool-handlers.ts via re-export
     export { default, tools } from '${resolve(REPO_ROOT, 'packages/marketplace/plugins/wb-character/server/tool-handlers')}';
    `,
  );
}

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
  return kinds;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
  mirrorPluginToTmp();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

describe('wb-character ToolRegistry wiring', () => {
  it('all manifest tools land in the snapshot with backendPath set', async () => {
    await reload();
    const tools = listTools();
    const charTools = tools.filter((t) => t.id.startsWith('character:'));
    expect(charTools).toHaveLength(TOOL_IDS.length);
    for (const id of TOOL_IDS) {
      const t = charTools.find((x) => x.id === id);
      expect(t).toBeDefined();
      expect(t!.hasHandler).toBe(true);
      // Only the 9 AI-facing tools opt into exposedToAI; the P4-funnel
      // stubs are internal (UI/save buttons), exposedToAI:false.
      const expectAi = AI_EXPOSED_TOOL_IDS.includes(id);
      expect(t!.exposedToAI).toBe(expectAi);
    }
  });

  it('ai caller is allowed because every tool opts into exposedToAI', async () => {
    await reload();
    const r = await callTool({
      toolId: 'character:list',
      args: { slug: 'nope-not-a-real-game' },
      caller: { kind: 'ai', threadId: 'th' },
    });
    // We can't assert ok=true (storage layer expects a real game dir) — but
    // the point is: AI gating must not reject. So the *kind* of failure
    // must not be `forbidden`.
    if (!r.ok) expect(r.code).not.toBe('forbidden');
  });

  it('unimplemented pipelines surface invoke_error with not_implemented in the message', async () => {
    await reload();
    const r = await callTool({
      toolId: 'character:generate-pixel',
      args: { slug: 'irrelevant' },
      caller: { kind: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('invoke_error');
      expect(r.error).toContain('not implemented');
    }
  });

  it('unknown tool id under character: namespace returns not_found', async () => {
    await reload();
    const r = await callTool({
      toolId: 'character:does-not-exist',
      args: {},
      caller: { kind: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});
