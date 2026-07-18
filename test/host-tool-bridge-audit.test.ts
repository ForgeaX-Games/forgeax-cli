/** host-tool-bridge 审计单测 —— 验证默认 forgeax-core 内核经 in-process 桥跑工具时,
 *  **每个决策出口都恰好追加一行** kernel-tool-audit.jsonl,字段 {allow, ok, error} 正确。
 *
 *  隔离手法(零全局 mock,杜绝跨文件污染):
 *   - 审计落 `getPathManager().session(sid).root()` = `<userRoot>/sessions/<sid>/`;
 *     用 initPathManager({ userRoot: tmp }) 把单例沙箱到临时目录,直接读回 JSONL 断言。
 *   - 桥的重协作方(session-manager / soul / trust-gate / tool-approval / tool-executor)经
 *     `makeInProcessExecuteTool` 的 deps 注入口传入桩,**不**用 bun 的进程全局 mock.module
 *     (后者注册后不随本文件撤销,会污染后续测试文件)。`appendToolAudit` 始终走真实实现
 *     (其写盘副作用即被断言对象)。
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { makeInProcessExecuteTool, type HostToolBridgeDeps } from '../src/kernel/host-tool-bridge';

// ── 可调的协作方行为(每个用例 beforeEach 重置后按需改写) ──────────────────
let trustTier: 'own' | 'imported';
let decision: { allow: boolean; outcome: 'allow' | 'ask' | 'deny'; capability?: string; reason?: string };
let approvalResult: boolean;
let execImpl: (..._a: unknown[]) => Promise<unknown>;
let agentLive: boolean;
let delegateHostConfirmation: boolean;
let approvalCalls: number;
let execCalls: number;

const fakeAgent = { agentContext: { tools: { list: () => [] } } };
const fakeSession = {
  eventBus: { publish: () => {} },
  scheduler: { getAgent: () => (agentLive ? fakeAgent : null) },
};

/** 用桩协作方装配桥(deps 注入口 —— 生产路径默认走真实实现)。 */
function makeBridge() {
  const deps: Partial<HostToolBridgeDeps> = {
    getSessionManager: (() => ({ peek: () => fakeSession, open: async () => fakeSession })) as unknown as HostToolBridgeDeps['getSessionManager'],
    loadAgentRecord: (async () => ({ trustTier })) as unknown as HostToolBridgeDeps['loadAgentRecord'],
    checkKernelTool: (() => decision) as unknown as HostToolBridgeDeps['checkKernelTool'],
    shouldDelegateHostToolConfirmation: (() => delegateHostConfirmation) as unknown as HostToolBridgeDeps['shouldDelegateHostToolConfirmation'],
    requestToolApproval: (async () => {
      approvalCalls += 1;
      return approvalResult;
    }) as unknown as HostToolBridgeDeps['requestToolApproval'],
    executeTool: ((...a: unknown[]) => {
      execCalls += 1;
      return execImpl(...a);
    }) as unknown as HostToolBridgeDeps['executeTool'],
  };
  return makeInProcessExecuteTool('forge', deps);
}

let tmpDir: string;
const SID = 'htb-audit-sid';

function readAudit(): Array<Record<string, unknown>> {
  const file = join(tmpDir, 'sessions', SID, 'kernel-tool-audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'htb-audit-'));
  initPathManager({ userRoot: tmpDir });
  // 默认:agent 在线 / own / allow / 审批通过 / 执行成功。各用例按需覆盖。
  agentLive = true;
  trustTier = 'own';
  decision = { allow: true, outcome: 'allow' };
  approvalResult = true;
  execImpl = async () => ({ result: 'ok' });
  delegateHostConfirmation = false;
  approvalCalls = 0;
  execCalls = 0;
});

afterEach(() => {
  resetPathManager();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('host-tool-bridge appendToolAudit', () => {
  test('allow + 执行成功 → 恰一行 {allow:true, ok:true}', async () => {
    const bridge = makeBridge();
    const out = await bridge('read_file', { path: 'x' }, SID, 'forge');
    expect(out).toEqual({ result: 'ok' });

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: SID, agent: 'forge', tool: 'read_file', trustTier: 'own', allow: true, ok: true });
    expect(rows[0].error).toBeUndefined();
    expect(typeof rows[0].durationMs).toBe('number');
    expect(typeof rows[0].ts).toBe('number');
  });

  test('deny → 抛 + 恰一行 {allow:false, error:reason}', async () => {
    decision = { allow: false, outcome: 'deny', reason: 'tool denied for imported pack' };
    trustTier = 'imported';
    const bridge = makeBridge();
    await expect(bridge('Bash', { command: 'rm -rf /' }, SID, 'forge')).rejects.toThrow('tool denied for imported pack');

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allow: false, trustTier: 'imported', tool: 'Bash', error: 'tool denied for imported pack' });
    expect(rows[0].ok).toBeUndefined();
  });

  test('ask 被用户拒绝 → 抛 + 恰一行 {allow:false, error:"denied by user"}', async () => {
    decision = { allow: false, outcome: 'ask', capability: 'exec', reason: 'confirm exec' };
    approvalResult = false;
    const bridge = makeBridge();
    await expect(bridge('run_cmd', {}, SID, 'forge')).rejects.toThrow('denied by user');

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allow: false, error: 'denied by user', tool: 'run_cmd' });
    expect(rows[0].ok).toBeUndefined();
  });

  test('ask 通过后执行成功 → 恰一行 {allow:true, ok:true}(不双记)', async () => {
    decision = { allow: false, outcome: 'ask', capability: 'exec' };
    approvalResult = true;
    const bridge = makeBridge();
    await bridge('run_cmd', {}, SID, 'forge');

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allow: true, ok: true, tool: 'run_cmd' });
    expect(approvalCalls).toBe(1);
    expect(execCalls).toBe(1);
  });

  test('ask + 下游 Host ToolRegistry 自带确认 → 跳过外层卡并只执行一次', async () => {
    decision = { allow: false, outcome: 'ask', capability: 'other' };
    delegateHostConfirmation = true;
    const bridge = makeBridge();
    await bridge('aiasset_import-to-engine', {}, SID, 'forge');

    expect(approvalCalls).toBe(0);
    expect(execCalls).toBe(1);
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allow: true, ok: true, tool: 'aiasset_import-to-engine' });
  });

  test('deny 不会被下游确认声明绕过', async () => {
    decision = { allow: false, outcome: 'deny', capability: 'credential', reason: 'hard deny' };
    delegateHostConfirmation = true;
    const bridge = makeBridge();
    await expect(bridge('get_secret', {}, SID, 'forge')).rejects.toThrow('hard deny');

    expect(approvalCalls).toBe(0);
    expect(execCalls).toBe(0);
  });

  test('allow + executeTool 抛 → rethrow + 恰一行 {allow:true, ok:false, error}', async () => {
    execImpl = async () => { throw new Error('boom inside tool'); };
    const bridge = makeBridge();
    await expect(bridge('read_file', {}, SID, 'forge')).rejects.toThrow('boom inside tool');

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allow: true, ok: false, error: 'boom inside tool', tool: 'read_file' });
  });

  test('agent 不在线 → 抛 + 恰一行 {trustTier:"unknown", allow:false}', async () => {
    agentLive = false;
    const bridge = makeBridge();
    await expect(bridge('read_file', {}, SID, 'forge')).rejects.toThrow('not live in session');

    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trustTier: 'unknown', allow: false });
    expect(String(rows[0].error)).toContain('not live in session');
  });
});
