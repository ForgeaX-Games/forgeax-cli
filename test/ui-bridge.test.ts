/** UI 语义操作层(产品 AI 化 P0)单测:
 *  - ui-manifest-registry:lease 生命周期(获焦 displace / 心跳续期 / TTL)、manifest
 *    写入的 lease 把关与声明消毒(非法 capability 整条丢弃,fail-closed)、超时查表。
 *  - trust-gate ui_invoke per-action 特判:capability 真值 = manifest 声明,**不信模型
 *    自报的 args**(防谎报);查不到声明 fail-closed ask。
 *  - perception-registry lease 把关:ui_* 回灌须持有效 lease,错 lease 不消费 pending。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  acquireUiLease,
  validateUiLease,
  setUiManifest,
  getUiAction,
  uiInvokeTimeoutMs,
  clearUiStateForSession,
  firstClassUiToolSpecs,
  resolveFirstClassUiTool,
} from '../src/api/lib/ui-manifest-registry';
import { checkKernelTool } from '../src/kernel/trust-gate';
import { registerPerception, resolvePerception } from '../src/api/lib/perception-registry';
import { runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { initOrchestrationSeams, resetOrchestrationSeams, getHostTool, getHostTools } from '../src/orchestration-seams';
import uiBridgeContract from '../src/kernel/ui-bridge-contract.json';

const SID = 'test-ui-bridge-sid';

function leaseFor(sid: string, clientId = 'tab-a'): string {
  return acquireUiLease(sid, clientId).leaseId;
}

beforeEach(() => {
  clearUiStateForSession(SID);
});

describe('ui-manifest-registry — lease', () => {
  test('acquire 授予;同 clientId 续期保持 leaseId 稳定', () => {
    const a = acquireUiLease(SID, 'tab-a');
    const b = acquireUiLease(SID, 'tab-a');
    expect(a.leaseId).toBe(b.leaseId);
    expect(validateUiLease(SID, a.leaseId)).toBe(true);
  });

  test('另一 tab acquire → displace(前任 lease 失效)', () => {
    const a = acquireUiLease(SID, 'tab-a');
    const b = acquireUiLease(SID, 'tab-b');
    expect(b.leaseId).not.toBe(a.leaseId);
    expect(validateUiLease(SID, a.leaseId)).toBe(false);
    expect(validateUiLease(SID, b.leaseId)).toBe(true);
  });

  test('validate:错值 / 空值 / 未知 sid 都拒', () => {
    expect(validateUiLease(SID, 'nope')).toBe(false);
    expect(validateUiLease(SID, '')).toBe(false);
    expect(validateUiLease(SID, undefined)).toBe(false);
    expect(validateUiLease('other-sid', leaseFor(SID))).toBe(false);
  });
});

describe('ui-manifest-registry — manifest(权限输入,lease 把守)', () => {
  const decl = (over: Record<string, unknown> = {}) => ({
    id: 'game.delete',
    title: 'Delete game',
    capability: 'delete',
    ...over,
  });

  test('无/错 lease 拒写(信任锚:谁能写 manifest 谁就能改权限声明)', () => {
    expect(setUiManifest(SID, [decl()], undefined).ok).toBe(false);
    expect(setUiManifest(SID, [decl()], 'bogus').ok).toBe(false);
    expect(getUiAction(SID, 'game.delete')).toBeUndefined();
  });

  test('持有效 lease 可写,可查表', () => {
    const lease = leaseFor(SID);
    const res = setUiManifest(SID, [decl()], lease);
    expect(res.ok).toBe(true);
    expect(res.accepted).toBe(1);
    expect(getUiAction(SID, 'game.delete')?.capability).toBe('delete');
  });

  test('非法 capability 整条丢弃(不降级 other——own tier other 会静默直放)', () => {
    const lease = leaseFor(SID);
    const res = setUiManifest(SID, [decl({ capability: 'superuser' }), decl({ id: 'ok.read', capability: 'read' })], lease);
    expect(res.ok).toBe(true);
    expect(res.accepted).toBe(1);
    expect(res.dropped).toBe(1);
    expect(getUiAction(SID, 'game.delete')).toBeUndefined();
    expect(getUiAction(SID, 'ok.read')?.capability).toBe('read');
  });

  test('整表替换幂等 + timeoutMs clamp [1s,30s]', () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [decl({ id: 'slow.op', capability: 'write', timeoutMs: 120_000 })], lease);
    expect(uiInvokeTimeoutMs(SID, 'slow.op', 10_000)).toBe(30_000);
    setUiManifest(SID, [decl({ id: 'slow.op', capability: 'write', timeoutMs: 5 })], lease);
    expect(uiInvokeTimeoutMs(SID, 'slow.op', 10_000)).toBe(1_000);
    expect(uiInvokeTimeoutMs(SID, 'unknown.op', 10_000)).toBe(10_000);
  });
});

describe('trust-gate — ui_invoke per-action 特判', () => {
  test('capability 真值 = manifest 声明:delete → ask(own),不因子串分类落 other 直放', () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'session.close', title: '关闭会话', capability: 'delete' }], lease);
    const d = checkKernelTool('own', 'ui_invoke', { args: { actionId: 'session.close' }, sid: SID });
    expect(d.outcome).toBe('ask');
    expect(d.capability).toBe('delete');
  });

  test('防谎报:模型在 args 里自报 capability 被无视,以 manifest 为准', () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'session.close', title: '关闭会话', capability: 'delete' }], lease);
    const d = checkKernelTool('own', 'ui_invoke', {
      args: { actionId: 'session.close', capability: 'read' }, // 谎报
      sid: SID,
    });
    expect(d.outcome).toBe('ask');
    expect(d.capability).toBe('delete');
  });

  test('read 声明 → own 直放;未注册 actionId / 缺 sid / 缺 actionId → fail-closed ask', () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'sessions.list', title: '列出会话', capability: 'read' }], lease);
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'sessions.list' }, sid: SID }).outcome).toBe('allow');
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'nope' }, sid: SID }).outcome).toBe('ask');
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'sessions.list' } }).outcome).toBe('ask');
    expect(checkKernelTool('own', 'ui_invoke', { args: {}, sid: SID }).outcome).toBe('ask');
  });

  test('imported:read 直放,write ask,credential 硬 deny', () => {
    const lease = leaseFor(SID);
    setUiManifest(
      SID,
      [
        { id: 'a.read', title: 'r', capability: 'read' },
        { id: 'a.write', title: 'w', capability: 'write' },
        { id: 'a.cred', title: 'c', capability: 'credential' },
      ],
      lease,
    );
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'a.read' }, sid: SID }).outcome).toBe('allow');
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'a.write' }, sid: SID }).outcome).toBe('ask');
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'a.cred' }, sid: SID }).outcome).toBe('deny');
  });

  test('ui_snapshot 归 read 直放(own+imported),不因 sh 子串误分 exec', () => {
    // 只读发现工具:两 tier 都直放,capability 显式 read(绕开 classifyTool 的 sh→exec)。
    expect(checkKernelTool('own', 'ui_snapshot', { sid: SID })).toMatchObject({ outcome: 'allow', capability: 'read' });
    expect(checkKernelTool('imported', 'ui_snapshot', { sid: SID })).toMatchObject({ outcome: 'allow', capability: 'read' });
  });
});

describe('perception-registry — ui_* 回灌的 lease 把关', () => {
  test('错 lease 不消费 pending(真持有者仍可回灌);对 lease 有效', async () => {
    const lease = leaseFor(SID);
    const handle = registerPerception('req-ui-1', 2_000, { requireLease: { sid: SID } });
    expect(resolvePerception('req-ui-1', { x: 1 }, 'bogus')).toBe(false);
    expect(resolvePerception('req-ui-1', { x: 1 }, lease)).toBe(true);
    expect(await handle.promise).toEqual({ x: 1 });
    handle.dispose();
  });

  test('传统 world/frame 不受 lease 影响(零回归)', async () => {
    const handle = registerPerception('req-world-1', 2_000);
    expect(resolvePerception('req-world-1', { ok: true })).toBe(true);
    expect(await handle.promise).toEqual({ ok: true });
    handle.dispose();
  });
});

describe('ui-bridge-contract — 契约单源与产品中立', () => {
  test('两个工具在契约里且 schema 齐全', () => {
    const names = uiBridgeContract.tools.map((t) => t.name).sort();
    expect(names).toEqual(['ui_invoke', 'ui_snapshot']);
    for (const t of uiBridgeContract.tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  test('措辞产品中立:不出现 game/ECS 等产品词(cli 层业务无关)', () => {
    for (const t of uiBridgeContract.tools) {
      expect(/\bgame\b|\becs\b/i.test(t.description)).toBe(false);
    }
  });

  test('ui_invoke 的 description 写明 accepted 勿等勿重试 + 用 ui_snapshot 观察(P0 断层提示)', () => {
    const invoke = uiBridgeContract.tools.find((t) => t.name === 'ui_invoke')!;
    expect(invoke.description).toMatch(/do NOT wait/i);
    expect(invoke.description).toMatch(/do NOT retry/i);
    expect(invoke.description).toMatch(/ui_snapshot/);
  });

  test('ui_snapshot 契约含 a11y 兜底档(P1-13)', () => {
    const snap = uiBridgeContract.tools.find((t) => t.name === 'ui_snapshot')!;
    const detail = (snap.inputSchema as { properties: { detail: { enum: string[] } } }).properties.detail;
    expect(detail.enum).toContain('a11y');
  });
});

describe('P1-9 一等工具化 — firstClass 派生与反解', () => {
  test('firstClass 声明派生 ui_act_* ToolSpec;非 firstClass 不派生;反解回 actionId', () => {
    const lease = leaseFor(SID);
    setUiManifest(
      SID,
      [
        { id: 'game.switch', title: '切换游戏', capability: 'write', firstClass: true },
        { id: 'console.clear', title: '清空控制台', capability: 'write' },
      ],
      lease,
    );
    const specs = firstClassUiToolSpecs(SID);
    expect(specs.map((s) => s.name)).toEqual(['ui_act_game_switch']);
    expect(specs[0]!.description).toContain('切换游戏');
    expect(specs[0]!.description).toMatch(/ui_snapshot/); // accepted 语义随身
    expect(resolveFirstClassUiTool(SID, 'ui_act_game_switch')).toEqual({ actionId: 'game.switch' });
    expect(resolveFirstClassUiTool(SID, 'ui_act_console_clear')).toBeUndefined();
    expect(resolveFirstClassUiTool(SID, 'not_a_ui_tool')).toBeUndefined();
    expect(firstClassUiToolSpecs(undefined)).toEqual([]);
  });
});

describe('P1-7 seam — HostToolSpec run 执行位', () => {
  afterEach(() => resetOrchestrationSeams());

  test('shell 注入后 getHostTool 可取,run 收到 ctx.perception', async () => {
    let seenKind = '';
    initOrchestrationSeams({
      hostTools: [
        {
          name: 'query_world',
          description: 'probe',
          inputSchema: { type: 'object', properties: {} },
          run: async (_args, ctx) => {
            if (!ctx.perception) return { unavailable: true };
            return ctx.perception('world', null);
          },
        },
      ],
    });
    expect(getHostTools().length).toBe(1);
    const tool = getHostTool('query_world')!;
    expect(tool.run).toBeTruthy();
    const out = (await tool.run!(
      {},
      {
        agentId: 'forge',
        projectRoot: '/tmp',
        perception: async (kind) => {
          seenKind = kind;
          return { entityCount: 3 };
        },
      },
    )) as { entityCount: number };
    expect(seenKind).toBe('world');
    expect(out.entityCount).toBe(3);
  });
});

describe('P1-8 headless 回落 — surface both/server 的 ui_invoke', () => {
  afterEach(() => resetOrchestrationSeams());

  test('UI 不在线(往返超时)→ seam handler 执行并标 executedVia', async () => {
    const lease = leaseFor(SID);
    // timeoutMs:5 → clamp 到 1s(测试代价);surface:'both' 允许回落。
    setUiManifest(SID, [{ id: 'sessions.list', title: '列会话', capability: 'read', surface: 'both', timeoutMs: 5 }], lease);
    initOrchestrationSeams({
      hostUiActions: [
        { actionId: 'sessions.list', run: () => ({ status: 'completed', stateDigest: [{ sid: 's1' }] }) },
      ],
    });
    const out = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'sessions.list', args: {} },
      { projectRoot: '/tmp', agentId: 'forge', sid: SID, eventBus: { publish: () => {} } }, // 无人应答 → 超时
    )) as { status: string; executedVia?: string; stateDigest?: unknown };
    expect(out.status).toBe('completed');
    expect(out.executedVia).toBe('headless');
    expect(out.stateDigest).toEqual([{ sid: 's1' }]);
  }, 10_000);

  test("surface:'ui' 不回落(unavailable 原样返回)", async () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'panel.toggle', title: '开合面板', capability: 'write', surface: 'ui', timeoutMs: 5 }], lease);
    initOrchestrationSeams({
      hostUiActions: [{ actionId: 'panel.toggle', run: () => ({ status: 'completed' }) }],
    });
    const out = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle', args: {} },
      { projectRoot: '/tmp', agentId: 'forge', sid: SID, eventBus: { publish: () => {} } },
    )) as { unavailable?: boolean };
    expect(out.unavailable).toBe(true);
  }, 10_000);
});
