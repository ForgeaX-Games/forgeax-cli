import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import hostToolBridge from '../builtin/kits/host-tools/plugins/host_tool_bridge';
import type { AgentContext, ToolDefinition } from '../src/core/types';
import {
  markHostToolDefinition,
  shouldDelegateHostToolConfirmation,
} from '../src/kernel/host-tool-confirmation';
import { ToolRegistry } from '../src/kits/tool-registry';
import { buildKindRegistry } from '../src/extensions/kinds';
import { mergeManifests } from '../src/extensions/merger';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import { scanAllLayers } from '../src/extensions/scanner';
import { resolveToolDescriptorByWireName } from '../src/tools/registry';

const TMP = `/tmp/forgeax-host-confirm-${process.pid}`;

function manifest(dirName: string, tools: Array<Record<string, unknown>>): void {
  const dir = join(TMP, 'L1', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: `@x/${dirName}`,
      version: '0.1.0',
      kind: 'tool',
      displayName: { zh: dirName, en: dirName },
      entry: { backend: './handler.mjs' },
      provides: { tools },
    }),
  );
}

async function reload(): Promise<void> {
  const roots = { L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') };
  const scan = await scanAllLayers(roots);
  const merged = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merged.manifests);
  _setSnapshotForTests({
    generation: 1,
    loadedAt: Date.now(),
    manifests: merged.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merged.issues,
  });
}

function tool(name: string, hostToolId?: string): ToolDefinition {
  const definition: ToolDefinition = {
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  };
  return hostToolId ? markHostToolDefinition(definition, hostToolId) : definition;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  for (const layer of ['L0', 'L1', 'L2']) mkdirSync(join(TMP, layer), { recursive: true });
  _resetSnapshotForTests();
});

afterEach(() => {
  _resetSnapshotForTests();
  rmSync(TMP, { recursive: true, force: true });
});

describe('Host ToolRegistry confirmation delegation', () => {
  test('真实 host_tool_bridge 注册的工具保留 Host 身份并委托下游确认', async () => {
    manifest('aiasset-real-bridge', [
      {
        id: 'aiasset:import-to-engine',
        exposedToAI: true,
        requireConfirm: 'destructive',
      },
    ]);
    await reload();
    const registry = new ToolRegistry();
    const source = hostToolBridge({
      agentPath: 'market-agent',
      agentDir: join(TMP, 'sessions', 'sid', 'agents', 'market-agent'),
      getAgentJson: () => ({
        kits: { config: { 'host-tools': { allow: ['aiasset:*'] } } },
      }),
      tools: registry,
      eventBus: { observe: () => () => undefined },
    } as unknown as AgentContext);

    await source.start();
    try {
      const bridged = registry.list();
      expect(bridged.map((entry) => entry.name)).toEqual(['aiasset_import-to-engine']);
      expect(shouldDelegateHostToolConfirmation('aiasset_import-to-engine', bridged)).toBe(true);
    } finally {
      await source.stop();
    }
  });

  test('唯一 wire name + destructive 确认 + 实际 Host bridge 工具 → 委托下游确认', async () => {
    manifest('aiasset', [
      {
        id: 'aiasset:import-to-engine',
        exposedToAI: true,
        requireConfirm: 'destructive',
      },
    ]);
    await reload();
    const wireName = 'aiasset_import-to-engine';
    const descriptor = resolveToolDescriptorByWireName(wireName);

    expect(descriptor).toMatchObject({
      id: 'aiasset:import-to-engine',
      requireConfirm: 'destructive',
      exposedToAI: true,
      hasHandler: true,
    });
    expect(
      shouldDelegateHostToolConfirmation(wireName, [tool(wireName, 'aiasset:import-to-engine')]),
    ).toBe(true);
  });

  test('两个 Host tool 归一化为同一 wire name → 保持外层确认', async () => {
    manifest('collision', [
      { id: 'demo:a.b', exposedToAI: true, requireConfirm: 'always' },
      { id: 'demo:a:b', exposedToAI: true, requireConfirm: 'always' },
    ]);
    await reload();
    const wireName = 'demo_a_b';

    expect(resolveToolDescriptorByWireName(wireName)).toBeNull();
    expect(shouldDelegateHostToolConfirmation(wireName, [tool(wireName, 'demo:a.b')])).toBe(false);
  });

  test('实际解析到非 Host 工具，即使同名 Host descriptor 存在也不委托', async () => {
    manifest('shadowed', [
      { id: 'demo:danger', exposedToAI: true, requireConfirm: 'always' },
    ]);
    await reload();
    const wireName = 'demo_danger';

    expect(
      shouldDelegateHostToolConfirmation(wireName, [
        tool(wireName),
        tool(wireName, 'demo:danger'),
      ]),
    ).toBe(false);

    const spoofed = tool(wireName) as ToolDefinition & { hostToolId?: string };
    spoofed.hostToolId = 'demo:danger';
    expect(shouldDelegateHostToolConfirmation(wireName, [spoofed])).toBe(false);
  });

  test('never 或未声明确认 → 保持原 trust-gate 行为', async () => {
    manifest('no-confirm', [
      { id: 'demo:never', exposedToAI: true, requireConfirm: 'never' },
      { id: 'demo:plain', exposedToAI: true },
    ]);
    await reload();

    expect(
      shouldDelegateHostToolConfirmation('demo_never', [tool('demo_never', 'demo:never')]),
    ).toBe(false);
    expect(
      shouldDelegateHostToolConfirmation('demo_plain', [tool('demo_plain', 'demo:plain')]),
    ).toBe(false);
  });
});
