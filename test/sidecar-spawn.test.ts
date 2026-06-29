/** sidecarSpawnJsonl 冒烟:对真 agent-host 跑假内核(bash 吐 ndjson),验 {lines,exit} + abort→cancel。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { SidecarClient } from '../src/kernel/sidecar-client';
import { sidecarSpawnJsonl } from '../src/kernel/sidecar-spawn';

const AGENT_HOST_MAIN = resolve(import.meta.dir, '../../agent-host/src/main.ts');
let sock = '';
let seq = 0;
let proc: Subprocess | null = null;

beforeEach(() => { sock = `/tmp/fxss-${process.pid}-${seq++}.sock`; });
afterEach(async () => {
  if (proc) { try { proc.kill(); } catch {} proc = null; }
  await new Promise((r) => setTimeout(r, 100));
  for (const p of [sock, `${sock}.pid`]) { try { rmSync(p, { force: true }); } catch {} }
});

async function startHostAndConnect(): Promise<SidecarClient> {
  proc = Bun.spawn({ cmd: ['bun', AGENT_HOST_MAIN], env: { ...process.env, FORGEAX_AGENT_HOST_SOCK: sock } as Record<string, string>, stdout: 'ignore', stderr: 'ignore' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const c = await SidecarClient.connect(sock, 1000); await c.ping(); return c; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('sidecar not reachable');
}

describe('sidecarSpawnJsonl', () => {
  test('假内核吐 ndjson → lines 解出 + exit{code:0}', async () => {
    const c = await startHostAndConnect();
    const { lines, exit } = sidecarSpawnJsonl<{ a?: number; b?: number }>(c, {
      sessionId: 'k1', agentId: 'x', trustTier: 'own',
      kernel: { kind: 'claude-code', credential: 'user-managed', cmd: 'bash', args: ['-c', 'echo \'{"a":1}\'; echo \'{"b":2}\''] },
    });
    const got: Array<{ a?: number; b?: number }> = [];
    for await (const l of lines) got.push(l);
    const ex = await exit;
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
    expect(ex.code).toBe(0);
    c.close();
  }, 20000);

  test('signal.abort → cancel 组杀,lines 终止', async () => {
    const c = await startHostAndConnect();
    const ac = new AbortController();
    const { lines, exit } = sidecarSpawnJsonl(c, {
      sessionId: 'k2', agentId: 'x', trustTier: 'own', callId: 'k2',
      kernel: { kind: 'claude-code', credential: 'user-managed', cmd: 'bash', args: ['-c', 'sleep 30'] },
    }, ac.signal);
    setTimeout(() => ac.abort(), 300);
    // lines 应在被 cancel 后结束(不挂死)
    for await (const _ of lines) { void _; }
    const ex = await exit;
    expect(ex.code).not.toBe(0); // 被杀 → 非 0
    c.close();
  }, 20000);
});
