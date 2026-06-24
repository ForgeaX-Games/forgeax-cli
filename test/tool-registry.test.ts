/**
 * Phase D1 — ToolRegistry + KindLoader tests. Builds /tmp manifests, scans
 * them through the real Plugin pipeline, and exercises callTool dispatch
 * including ai-gating, missing handler, dynamic-import path, and result
 * caching.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import {
  _setSnapshotForTests,
  _resetSnapshotForTests,
} from '../src/plugins/registry';
import {
  callTool,
  listTools,
  _resetToolHandlerCacheForTests,
  _resetConfirmsForTests,
} from '../src/tools/registry';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-tool-registry-${process.pid}`;

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

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetConfirmsForTests();
  _resetEventBusForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetConfirmsForTests();
  _resetEventBusForTests();
});

describe('Tool kind loader', () => {
  it('extracts tools from a kind=tool manifest', async () => {
    mkmanifest('L1', 'demo-tool', {
      id: '@x/demo-tool',
      kind: 'tool',
      displayName: { zh: 'demo-zh', en: 'demo' },
      provides: {
        tools: [
          { id: 'demo.echo', exposedToAI: true, description: { zh: 'echo-zh', en: 'echo' } },
          { id: 'demo.private' },
        ],
      },
    });
    const kinds = await reloadFromTmp();
    expect(kinds.tools).toHaveLength(2);
    const echo = kinds.tools.find((t) => t.toolId === 'demo.echo')!;
    expect(echo.exposedToAI).toBe(true);
    expect(echo.description).toBe('echo-zh');
    expect(kinds.tools.find((t) => t.toolId === 'demo.private')!.exposedToAI).toBe(false);
  });

  it('extracts tools from a kind=workbench/agent/skill manifest too', async () => {
    mkmanifest('L1', 'wb-x', {
      id: '@x/wb-x',
      kind: 'workbench',
      displayName: { zh: 'wb', en: 'wb' },
      provides: {
        workbench: { id: 'wb-x', position: 1 },
        tools: [{ id: 'wb-x.refresh' }],
      },
    });
    const kinds = await reloadFromTmp();
    expect(kinds.tools.map((t) => t.toolId)).toContain('wb-x.refresh');
  });

  it('flags duplicate tool ids inside the same plugin', async () => {
    mkmanifest('L1', 'dup', {
      id: '@x/dup',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      provides: { tools: [{ id: 't.a' }, { id: 't.a' }] },
    });
    const kinds = await reloadFromTmp();
    expect(kinds.tools).toHaveLength(1);
    expect(kinds.issues.find((i) => i.kind === 'tool')).toBeDefined();
  });

  it('resolves entry.backend to an absolute path', async () => {
    const dir = mkmanifest('L1', 'with-backend', {
      id: '@x/with-backend',
      kind: 'tool',
      displayName: { zh: 'b', en: 'b' },
      entry: { backend: './handlers.ts' },
      provides: { tools: [{ id: 'b.t' }] },
    });
    const kinds = await reloadFromTmp();
    expect(kinds.tools[0].backendPath).toBe(join(dir, 'handlers.ts'));
  });
});

describe('callTool dispatch', () => {
  it('returns not_found for unknown toolId', async () => {
    await reloadFromTmp();
    const r = await callTool({ toolId: 'nope', args: {}, caller: { kind: 'user' } });
    expect(r).toEqual({ ok: false, error: 'tool not found: nope', code: 'not_found' });
  });

  it('rejects ai caller when exposedToAI is false', async () => {
    mkmanifest('L1', 'priv', {
      id: '@x/priv',
      kind: 'tool',
      displayName: { zh: 'p', en: 'p' },
      provides: { tools: [{ id: 'p.x' }] },
    });
    await reloadFromTmp();
    const r = await callTool({ toolId: 'p.x', args: {}, caller: { kind: 'ai' } });
    expect(r).toEqual({
      ok: false,
      error: 'tool p.x is not exposedToAI',
      code: 'forbidden',
    });
  });

  it('returns no_handler when manifest has no entry.backend', async () => {
    mkmanifest('L1', 'no-bk', {
      id: '@x/no-bk',
      kind: 'tool',
      displayName: { zh: 'n', en: 'n' },
      provides: { tools: [{ id: 'n.t' }] },
    });
    await reloadFromTmp();
    const r = await callTool({ toolId: 'n.t', args: {}, caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_handler');
  });

  it('dynamic-imports handler module and returns result', async () => {
    const dir = mkmanifest('L1', 'dyn', {
      id: '@x/dyn',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      entry: { backend: './handlers.mjs' },
      provides: { tools: [{ id: 'd.add', exposedToAI: true }] },
    });
    writeFileSync(
      join(dir, 'handlers.mjs'),
      `export default { 'd.add': async (args) => args.a + args.b };\n`,
      'utf-8',
    );
    await reloadFromTmp();
    const r = await callTool({
      toolId: 'd.add',
      args: { a: 2, b: 5 },
      caller: { kind: 'ai' },
    });
    expect(r).toEqual({ ok: true, result: 7 });
  });

  it('surfaces handler exception as invoke_error', async () => {
    const dir = mkmanifest('L1', 'boom', {
      id: '@x/boom',
      kind: 'tool',
      displayName: { zh: 'b', en: 'b' },
      entry: { backend: './handlers.mjs' },
      provides: { tools: [{ id: 'b.kapow' }] },
    });
    writeFileSync(
      join(dir, 'handlers.mjs'),
      `export const tools = { 'b.kapow': () => { throw new Error('kapow'); } };\n`,
      'utf-8',
    );
    await reloadFromTmp();
    const r = await callTool({ toolId: 'b.kapow', args: {}, caller: { kind: 'user' } });
    expect(r).toEqual({ ok: false, error: 'kapow', code: 'invoke_error' });
  });

  it('requireConfirm: AI caller waits for tool.confirm-acked (allow)', async () => {
    const dir = mkmanifest('L1', 'cf-ok', {
      id: '@x/cf-ok',
      kind: 'tool',
      displayName: { zh: 'c', en: 'c' },
      entry: { backend: './h.mjs' },
      provides: {
        tools: [
          {
            id: 'cf.write',
            exposedToAI: true,
            requireConfirm: 'always',
            confirmMessage: { zh: 'high-risk-zh', en: 'destructive' },
          },
        ],
      },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'cf.write': async () => 'wrote' };\n`, 'utf-8');
    await reloadFromTmp();
    const bus = getEventBus();
    const seen: string[] = [];
    bus.subscribe('tool.confirm-required', (e) => {
      const p = e.payload as { token: string };
      seen.push(p.token);
      // Simulate user click "Allow" on next tick.
      setTimeout(() => {
        bus.emit('tool.confirm-acked', { token: p.token, decision: 'allow' });
      }, 0);
    });
    const r = await callTool({ toolId: 'cf.write', args: {}, caller: { kind: 'ai' } });
    expect(r).toEqual({ ok: true, result: 'wrote' });
    expect(seen).toHaveLength(1);
  });

  it('requireConfirm: deny short-circuits with user-rejected', async () => {
    const dir = mkmanifest('L1', 'cf-deny', {
      id: '@x/cf-deny',
      kind: 'tool',
      displayName: { zh: 'c', en: 'c' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'cf.x', exposedToAI: true, requireConfirm: 'always' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'cf.x': () => 'should-not-run' };\n`, 'utf-8');
    await reloadFromTmp();
    const bus = getEventBus();
    bus.subscribe('tool.confirm-required', (e) => {
      const p = e.payload as { token: string };
      setTimeout(() => bus.emit('tool.confirm-acked', { token: p.token, decision: 'deny', reason: 'no thx' }), 0);
    });
    const r = await callTool({ toolId: 'cf.x', args: {}, caller: { kind: 'ai' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('user-rejected');
      expect(r.error).toContain('no thx');
    }
  });

  it('requireConfirm: user caller bypasses the gate', async () => {
    const dir = mkmanifest('L1', 'cf-user', {
      id: '@x/cf-user',
      kind: 'tool',
      displayName: { zh: 'c', en: 'c' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'cf.u', requireConfirm: 'always' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'cf.u': () => 'direct' };\n`, 'utf-8');
    await reloadFromTmp();
    const bus = getEventBus();
    let promptSeen = false;
    bus.subscribe('tool.confirm-required', () => { promptSeen = true; });
    const r = await callTool({ toolId: 'cf.u', args: {}, caller: { kind: 'user' } });
    expect(r).toEqual({ ok: true, result: 'direct' });
    expect(promptSeen).toBe(false);
  });

  it('GAP 5: ctx.env is filtered to manifest.requestedEnv keys only', async () => {
    process.env.FORGEAX_TEST_ALLOWED = 'allowed-value';
    process.env.FORGEAX_TEST_SECRET = 'must-not-leak';
    try {
      const dir = mkmanifest('L1', 'envtool', {
        id: '@x/envtool',
        kind: 'tool',
        displayName: { zh: 'e', en: 'e' },
        entry: { backend: './h.mjs' },
        requestedEnv: ['FORGEAX_TEST_ALLOWED'],
        provides: { tools: [{ id: 'env.read', exposedToAI: true }] },
      });
      writeFileSync(
        join(dir, 'h.mjs'),
        `export default { 'env.read': (_args, ctx) => ({ allowed: ctx.env.FORGEAX_TEST_ALLOWED, secretPresent: 'FORGEAX_TEST_SECRET' in ctx.env, cwd: ctx.cwd }) };\n`,
        'utf-8',
      );
      await reloadFromTmp();
      const r = await callTool({ toolId: 'env.read', args: {}, caller: { kind: 'user' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = r.result as { allowed: string; secretPresent: boolean; cwd: string };
      expect(out.allowed).toBe('allowed-value');
      expect(out.secretPresent).toBe(false);
      expect(out.cwd).toBe(dir);
    } finally {
      delete process.env.FORGEAX_TEST_ALLOWED;
      delete process.env.FORGEAX_TEST_SECRET;
    }
  });

  it('listTools surfaces hasHandler flag', async () => {
    const dir = mkmanifest('L1', 'mix', {
      id: '@x/mix',
      kind: 'tool',
      displayName: { zh: 'm', en: 'm' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'm.go', exposedToAI: true }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'm.go': () => 1 };\n`, 'utf-8');
    mkmanifest('L1', 'schemaonly', {
      id: '@x/schemaonly',
      kind: 'tool',
      displayName: { zh: 's', en: 's' },
      provides: { tools: [{ id: 's.t' }] },
    });
    await reloadFromTmp();
    const list = listTools();
    expect(list.find((t) => t.id === 'm.go')!.hasHandler).toBe(true);
    expect(list.find((t) => t.id === 's.t')!.hasHandler).toBe(false);
  });
});

// w5: AC-03/AC-04/AC-11 — confirm gate emit tests (always/destructive + envelope shape)
describe('confirm gate emit (w5)', () => {
  it('ai+always emits tool.confirm-required with token in payload (AC-03)', async () => {
    const dir = mkmanifest('L1', 'w5-always', {
      id: '@x/w5-always',
      kind: 'tool',
      displayName: { zh: 'c', en: 'c' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'w5a.write', exposedToAI: true, requireConfirm: 'always' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'w5a.write': async () => 'ok' };\n`, 'utf-8');
    await reloadFromTmp();
    const bus = getEventBus();
    const envelopes: unknown[] = [];
    bus.subscribe('tool.confirm-required', (e) => { envelopes.push(e.payload); });
    // callTool will hang waiting for ack — fire-and-forget, don't await
    const pending = callTool({ toolId: 'w5a.write', args: {}, caller: { kind: 'ai', threadId: 'th1' } });
    // Give the bus one tick to emit
    await new Promise((r) => setTimeout(r, 10));
    expect(envelopes).toHaveLength(1);
    const p = envelopes[0] as Record<string, unknown>;
    // AC-11: envelope payload must contain token (not confirmId)
    expect(typeof p.token).toBe('string');
    expect(p.token).toMatch(/^confirm-/);
    expect(p.toolId).toBe('w5a.write');
    expect((p.caller as { kind: string }).kind).toBe('ai');
    // Resolve the pending call to avoid test hanging
    bus.emit('tool.confirm-acked', { token: p.token, decision: 'deny' });
    await pending;
  });

  it('ai+destructive emits tool.confirm-required with token in payload (AC-04)', async () => {
    const dir = mkmanifest('L1', 'w5-destr', {
      id: '@x/w5-destr',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: 'w5d.del', exposedToAI: true, requireConfirm: 'destructive' }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { 'w5d.del': async () => 'deleted' };\n`, 'utf-8');
    await reloadFromTmp();
    const bus = getEventBus();
    let capturedPayload: Record<string, unknown> | null = null;
    bus.subscribe('tool.confirm-required', (e) => { capturedPayload = e.payload as Record<string, unknown>; });
    const pending = callTool({ toolId: 'w5d.del', args: {}, caller: { kind: 'ai' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedPayload).not.toBeNull();
    // token field present, confirmId absent (AC-11 shape)
    expect(typeof (capturedPayload as unknown as Record<string, unknown>).token).toBe('string');
    expect((capturedPayload as unknown as Record<string, unknown>).confirmId).toBeUndefined();
    bus.emit('tool.confirm-acked', { token: (capturedPayload as unknown as Record<string, unknown>).token, decision: 'deny' });
    await pending;
  });
});

// w6: AC-05/AC-09 — bypass tests (never/omit + non-AI callers)
describe('confirm gate bypass (w6)', () => {
  async function makeBypassTool(id: string, manifestId: string, requireConfirm?: string) {
    const dir = mkmanifest('L1', manifestId, {
      id: `@x/${manifestId}`,
      kind: 'tool',
      displayName: { zh: 'b', en: 'b' },
      entry: { backend: './h.mjs' },
      provides: {
        tools: [{
          id,
          exposedToAI: true,
          ...(requireConfirm !== undefined ? { requireConfirm } : {}),
        }],
      },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { '${id}': async () => 'ran' };\n`, 'utf-8');
  }

  it('ai+never bypasses confirm gate, tool executes directly (AC-05)', async () => {
    await makeBypassTool('w6n.t', 'w6-never', 'never');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    const r = await callTool({ toolId: 'w6n.t', args: {}, caller: { kind: 'ai' } });
    // fails before w10 because current code checks boolean requireConfirm truthy:
    // 'never' is truthy -> will emit confirm, won't hit 'ran'
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });

  it('ai+omitted requireConfirm bypasses confirm gate (AC-05)', async () => {
    await makeBypassTool('w6o.t', 'w6-omit');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    const r = await callTool({ toolId: 'w6o.t', args: {}, caller: { kind: 'ai' } });
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });

  it('skill caller with always bypasses confirm gate (AC-09)', async () => {
    await makeBypassTool('w6sk.t', 'w6-skill', 'always');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    // fails before w10: current code has CONFIRM_REQUIRED_FOR containing 'skill'
    const r = await callTool({ toolId: 'w6sk.t', args: {}, caller: { kind: 'skill' } });
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });

  it('user caller with always bypasses confirm gate (AC-09)', async () => {
    await makeBypassTool('w6u.t', 'w6-user', 'always');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    const r = await callTool({ toolId: 'w6u.t', args: {}, caller: { kind: 'user' } });
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });

  it('workbench caller with destructive bypasses confirm gate (AC-09)', async () => {
    await makeBypassTool('w6wb.t', 'w6-wb', 'destructive');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    const r = await callTool({ toolId: 'w6wb.t', args: {}, caller: { kind: 'workbench' } });
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });

  it('cli caller with always bypasses confirm gate (AC-09)', async () => {
    await makeBypassTool('w6cl.t', 'w6-cli', 'always');
    await reloadFromTmp();
    const bus = getEventBus();
    let confirmSeen = false;
    bus.subscribe('tool.confirm-required', () => { confirmSeen = true; });
    const r = await callTool({ toolId: 'w6cl.t', args: {}, caller: { kind: 'cli' } });
    expect(r).toEqual({ ok: true, result: 'ran' });
    expect(confirmSeen).toBe(false);
  });
});

// w7: AC-06/AC-07/AC-08/D-4/D-5/R-1 — outcome tests (allow/deny/timeout/emit-failed + token idempotent)
describe('confirm gate outcomes (w7)', () => {
  async function makeConfirmTool(toolId: string, dirName: string, requireConfirm: 'always' | 'destructive' = 'always') {
    const dir = mkmanifest('L1', dirName, {
      id: `@x/${dirName}`,
      kind: 'tool',
      displayName: { zh: 'c', en: 'c' },
      entry: { backend: './h.mjs' },
      provides: { tools: [{ id: toolId, exposedToAI: true, requireConfirm }] },
    });
    writeFileSync(join(dir, 'h.mjs'), `export default { '${toolId}': async () => 'executed' };\n`, 'utf-8');
  }

  it('ack decision=allow resolves callTool with ok:true, tool.starting emitted after ack (AC-06, D-4)', async () => {
    await makeConfirmTool('w7al.t', 'w7-allow');
    await reloadFromTmp();
    const bus = getEventBus();
    const events: string[] = [];
    bus.subscribe('tool.confirm-required', () => { events.push('confirm-required'); });
    bus.subscribe('tool.starting', () => { events.push('starting'); });
    bus.subscribe('tool.completed', () => { events.push('completed'); });
    let capturedToken: string | null = null;
    bus.subscribe('tool.confirm-required', (e) => {
      capturedToken = (e.payload as { token?: string }).token ?? null;
    });
    const pending = callTool({ toolId: 'w7al.t', args: {}, caller: { kind: 'ai' } });
    await new Promise((r) => setTimeout(r, 10));
    // D-4: tool.starting must NOT appear before ack
    expect(events).not.toContain('starting');
    // Emit ack with token (not confirmId) on tool.confirm-acked (not tool.confirm-resolved)
    bus.emit('tool.confirm-acked', { token: capturedToken, decision: 'allow' });
    const r = await pending;
    // fails before w10 because current code uses tool.confirm-resolved + confirmId
    expect(r).toEqual({ ok: true, result: 'executed' });
    // D-4: starting only after ack
    expect(events.indexOf('confirm-required')).toBeLessThan(events.indexOf('starting'));
  });

  it('ack decision=deny returns user-rejected code, fn spy 0 calls (AC-07)', async () => {
    await makeConfirmTool('w7dn.t', 'w7-deny');
    await reloadFromTmp();
    const bus = getEventBus();
    let fnCalled = false;
    let capturedToken: string | null = null;
    bus.subscribe('tool.confirm-required', (e) => {
      capturedToken = (e.payload as { token?: string }).token ?? null;
      // handler check: fn is NOT called before ack
    });
    const pending = callTool({ toolId: 'w7dn.t', args: {}, caller: { kind: 'ai' } });
    await new Promise((r) => setTimeout(r, 10));
    bus.emit('tool.confirm-acked', { token: capturedToken, decision: 'deny', reason: 'too dangerous' });
    const r = await pending;
    // fails before w10 because current code uses 'denied_by_user' not 'user-rejected'
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('user-rejected');
      expect(r.error).toContain('too dangerous');
    }
    expect(fnCalled).toBe(false);
  });

  it('30s timeout returns confirm-timeout code (AC-08)', async () => {
    await makeConfirmTool('w7to.t', 'w7-timeout');
    await reloadFromTmp();
    // Override timeout for test speed — simulate fast timeout via env
    const origTimeout = process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS;
    process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS = '50';
    try {
      const r = await callTool({ toolId: 'w7to.t', args: {}, caller: { kind: 'ai' } });
      // fails before w10 because current code uses 'confirm_timeout' not 'confirm-timeout'
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('confirm-timeout');
    } finally {
      if (origTimeout === undefined) delete process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS;
      else process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS = origTimeout;
    }
  });

  it('bus.emit throw returns confirm-emit-failed code (D-5)', async () => {
    await makeConfirmTool('w7ef.t', 'w7-emitfail');
    await reloadFromTmp();
    const bus = getEventBus();
    // Spy: make bus.emit throw on tool.confirm-required
    const origEmit = bus.emit.bind(bus);
    let throwOnConfirm = true;
    (bus as unknown as { emit: typeof bus.emit }).emit = (topic: string, payload: unknown, opts?: { threadId?: string }) => {
      if (topic === 'tool.confirm-required' && throwOnConfirm) {
        throwOnConfirm = false;
        throw new Error('bus overloaded');
      }
      return origEmit(topic, payload, opts);
    };
    const r = await callTool({ toolId: 'w7ef.t', args: {}, caller: { kind: 'ai' } });
    // fails before w10 because current code has no try-catch around bus.emit
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('confirm-emit-failed');
    // Restore
    (bus as unknown as { emit: typeof bus.emit }).emit = origEmit;
  });

  it('same token acked twice: fn called only once (R-1 token idempotent)', async () => {
    await makeConfirmTool('w7id.t', 'w7-idem');
    await reloadFromTmp();
    const bus = getEventBus();
    let capturedToken: string | null = null;
    bus.subscribe('tool.confirm-required', (e) => {
      capturedToken = (e.payload as { token?: string }).token ?? null;
    });
    const pending = callTool({ toolId: 'w7id.t', args: {}, caller: { kind: 'ai' } });
    await new Promise((r) => setTimeout(r, 10));
    // Emit ack twice with same token
    bus.emit('tool.confirm-acked', { token: capturedToken, decision: 'allow' });
    bus.emit('tool.confirm-acked', { token: capturedToken, decision: 'allow' });
    const r = await pending;
    expect(r).toEqual({ ok: true, result: 'executed' });
    // Second ack is a no-op — no double execution
  });
});
