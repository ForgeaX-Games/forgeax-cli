import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createSessionsRouter } from '../src/api/sessions';
import type { ToolDefinition } from '../src/core/types';
import { denyPermissionsForSession } from '../src/core/permission-registry';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { markHostToolDefinition } from '../src/kernel/host-tool-confirmation';
import { buildKindRegistry } from '../src/extensions/kinds';
import { mergeManifests } from '../src/extensions/merger';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import { scanAllLayers } from '../src/extensions/scanner';
import { callTool, _resetConfirmsForTests, _resetToolHandlerCacheForTests } from '../src/tools/registry';

let root: string;
let pluginRoot: string;
let sid: string;
let app: Hono;
let outerCards: number;
let innerCards: number;
let innerDecision: 'allow' | 'deny';
let executionMarker: string;
let savedProjectRoot: string | undefined;

function bridgedTool(name: string, hostToolId: string): ToolDefinition {
  return markHostToolDefinition({
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
    execute: async (args) => {
      const result = await callTool({
        toolId: hostToolId,
        args,
        caller: { kind: 'ai', agentId: 'market-agent', sessionId: sid, threadId: sid },
      });
      return JSON.stringify(result.ok ? result.result : { error: result.error, code: result.code });
    },
  }, hostToolId);
}

async function loadTools(): Promise<void> {
  const dir = join(pluginRoot, 'L1', 'host-tools');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: '@x/host-tools',
      version: '0.1.0',
      kind: 'tool',
      displayName: { zh: 'host-tools', en: 'host-tools' },
      entry: { backend: './handler.mjs' },
      provides: {
        tools: [
          { id: 'aiasset:import-to-engine', exposedToAI: true, requireConfirm: 'destructive' },
          { id: 'demo:plain', exposedToAI: true },
          { id: 'demo:scope', exposedToAI: true },
          { id: 'demo:get-token', exposedToAI: true, requireConfirm: 'always' },
          { id: 'remember', exposedToAI: true, requireConfirm: 'destructive' },
        ],
      },
    }),
  );
  writeFileSync(
    join(dir, 'handler.mjs'),
    `import { appendFileSync } from 'node:fs';
    export default {
      'aiasset:import-to-engine': async () => {
        appendFileSync(${JSON.stringify(executionMarker)}, 'import\\n');
        return { imported: true };
      },
      'demo:plain': async () => ({ plain: true }),
      'demo:scope': async (_args, ctx) => ({ game: ctx.game ?? null }),
      'demo:get-token': async () => ({ secret: true }),
    };\n`,
  );
  const roots = {
    L0: join(pluginRoot, 'L0'),
    L1: join(pluginRoot, 'L1'),
    L2: join(pluginRoot, 'L2'),
  };
  for (const dirPath of Object.values(roots)) mkdirSync(dirPath, { recursive: true });
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

async function postTool(toolName: string): Promise<any> {
  const response = await app.request(`/api/sessions/${sid}/kernel-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentPath: 'market-agent', toolName, args: {} }),
  });
  return response.json();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'forgeax-kernel-confirm-'));
  pluginRoot = mkdtempSync(join(tmpdir(), 'forgeax-kernel-confirm-plugins-'));
  executionMarker = join(root, 'import-executions.log');
  savedProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = root;
  const importedSoul = join(root, '.forgeax', 'souls-imported', 'market-agent', 'persona');
  mkdirSync(importedSoul, { recursive: true });
  writeFileSync(join(importedSoul, 'identity.md'), '# Imported test agent\n');
  resetPathManager();
  await resetSessionManager();
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetConfirmsForTests();
  _resetEventBusForTests();
  await loadTools();

  const pathManager = initPathManager({ userRoot: root });
  const sessionManager = initSessionManager(pathManager);
  const session = await sessionManager.create({ autoStart: false });
  sid = session.sid;
  session.config.defaultDir = 'game-bound-to-session';
  const tools = [
    bridgedTool('aiasset_import-to-engine', 'aiasset:import-to-engine'),
    bridgedTool('demo_plain', 'demo:plain'),
    bridgedTool('demo_scope', 'demo:scope'),
    bridgedTool('demo_get-token', 'demo:get-token'),
    bridgedTool('remember', 'remember'),
  ];
  const fakeAgent = { agentContext: { tools: { list: () => tools } } };
  (session.scheduler as unknown as { getAgent: () => unknown }).getAgent = () => fakeAgent;

  app = new Hono().route('/api/sessions', createSessionsRouter());
  outerCards = 0;
  innerCards = 0;
  innerDecision = 'allow';
  session.eventBus.observe((event) => {
    if (event.type !== 'permission:request') return;
    outerCards += 1;
    const reqId = (event.payload as { reqId: string }).reqId;
    queueMicrotask(() => {
      void app.request(`/api/sessions/${sid}/permission-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reqId, allow: true }),
      });
    });
  });
  getEventBus().subscribe('tool.confirm-required', (event) => {
    innerCards += 1;
    const token = (event.payload as { token: string }).token;
    queueMicrotask(() => getEventBus().emit('tool.confirm-acked', { token, decision: innerDecision }));
  });
});

afterEach(async () => {
  denyPermissionsForSession(sid);
  _resetConfirmsForTests();
  _resetEventBusForTests();
  _resetToolHandlerCacheForTests();
  _resetSnapshotForTests();
  await resetSessionManager();
  resetPathManager();
  if (savedProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = savedProjectRoot;
  rmSync(root, { recursive: true, force: true });
  rmSync(pluginRoot, { recursive: true, force: true });
});

describe('POST /:sid/kernel-tool Host confirmation delegation', () => {
  test('下游 requireConfirm 工具只出现一张 ToolRegistry 卡', async () => {
    const json = await postTool('aiasset_import-to-engine');

    expect(json.ok).toBe(true);
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(1);
    expect(readFileSync(executionMarker, 'utf8')).toBe('import\n');
  });

  test('下游 ToolRegistry 拒绝时保持单卡且 handler 执行零次', async () => {
    innerDecision = 'deny';
    const json = await postTool('aiasset_import-to-engine');

    expect(json.ok).toBe(true);
    expect(JSON.parse(json.result)).toMatchObject({ code: 'user-rejected' });
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(1);
    expect(existsSync(executionMarker)).toBe(false);
  });

  test('下游无 requireConfirm 时保留原 trust-gate 卡', async () => {
    const json = await postTool('demo_plain');

    expect(json.ok).toBe(true);
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });

  test('ToolRegistry 向插件注入调用会话绑定的 game，而非模型参数', async () => {
    const json = await postTool('demo_scope');

    expect(json.ok).toBe(true);
    expect(JSON.parse(json.result)).toEqual({ game: 'game-bound-to-session' });
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });

  test('credential 硬拒绝优先，不会进入任一确认或执行', async () => {
    const json = await postTool('demo_get-token');

    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('denied');
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(0);
  });

  test('内置工具同名时保留外层确认，不会假设 ToolRegistry 会执行', async () => {
    const json = await postTool('remember');

    expect(json.ok).toBe(false);
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });
});
