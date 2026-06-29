/** C10 (plan B PR2) — imported 工具的「当前 game 目录内」写豁免,作用域基准必须是
 *  **该 session 永久绑定的 game**(config.defaultDir,由路径派生),而非全局 active game。
 *  否则:session 绑 A、用户把 active 切到 B 时,会用 B 的目录去判 A 自己的写 → 误判。
 *
 *  做法:桩一个 config.defaultDir='bound-A' 的 session + 捕获 checkKernelTool 收到的
 *  ctx.activeGame;断言它 = 'bound-A'。因 `session.config?.defaultDir ?? getActiveGame()`
 *  短路,绑定值存在时 active 永不被查到 —— 即"跟随绑定 game"的保证。 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { makeInProcessExecuteTool, type HostToolBridgeDeps } from '../src/kernel/host-tool-bridge';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'htb-scope-'));
  initPathManager({ userRoot: tmp });
});
afterEach(() => {
  resetPathManager();
  rmSync(tmp, { recursive: true, force: true });
});

test('C10: 写豁免作用域 = session 绑定 game(config.defaultDir),非全局 active', async () => {
  let capturedScope: unknown = '__UNSET__';
  const fakeAgent = { agentContext: { tools: { list: () => [] } } };
  const boundSession = {
    config: { defaultDir: 'bound-A' }, // 该 session 永久绑定 game A
    eventBus: { publish: () => {} },
    scheduler: { getAgent: () => fakeAgent },
  };
  const deps: Partial<HostToolBridgeDeps> = {
    getSessionManager: (() => ({ peek: () => boundSession, open: async () => boundSession })) as unknown as HostToolBridgeDeps['getSessionManager'],
    loadAgentRecord: (async () => ({ trustTier: 'imported' })) as unknown as HostToolBridgeDeps['loadAgentRecord'],
    checkKernelTool: ((_tier: unknown, _name: unknown, ctx: { activeGame?: string }) => {
      capturedScope = ctx.activeGame;
      return { allow: true, outcome: 'allow' };
    }) as unknown as HostToolBridgeDeps['checkKernelTool'],
    requestToolApproval: (async () => true) as unknown as HostToolBridgeDeps['requestToolApproval'],
    executeTool: (async () => 'ok') as unknown as HostToolBridgeDeps['executeTool'],
  };
  const bridge = makeInProcessExecuteTool('forge', deps);
  await bridge('Write', { file_path: 'x.ts' }, 'sid-c10', 'forge');
  expect(capturedScope).toBe('bound-A');
});
