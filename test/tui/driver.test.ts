/**
 * T10 — agent driver(embed CoreAgent)用 --demo provider 跑一轮,断言事件序列。
 *
 * 走 host-context 全量装配(buildHostContext,demo=true 免 key)→ createAgentDriver
 * (直构 CoreAgent,不经 runTurn)→ driveTurn 收集 AgentEvent。验:
 *   - 序列含 turn_start … assistant … done(契约 T2 / DoD §T2)。
 *   - assistant 文本带回显(demo provider 闭环证据)。
 *   - driver.model 暴露当前模型;allowAlways / setMode / setAskUser / abort 可调不抛。
 *   - dispose 干净退出(disposers await)。
 */
import { test, expect, describe } from 'bun:test';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import type { AgentEvent } from '../../src/tui/contracts';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';
import { EMPTY_USAGE } from '../../src/provider/types';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;

// ── 脚本化 provider(权限模式同步用;对齐 test/agent-mode.test.ts 的形状)──
function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function scriptedProvider(scripts: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
}

describe('agent driver (demo provider, no key)', () => {
  test('driveTurn emits turn_start … assistant … done in order', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('ping', (e) => events.push(e));
      const types = events.map((e) => e.type);

      expect(types).toContain('turn_start');
      expect(types).toContain('assistant');
      expect(types).toContain('done');

      // 顺序:turn_start 在 assistant 前,assistant 在 done 前。
      const iStart = types.indexOf('turn_start');
      const iAssistant = types.indexOf('assistant');
      const iDone = types.indexOf('done');
      expect(iStart).toBeLessThan(iAssistant);
      expect(iAssistant).toBeLessThan(iDone);
    } finally {
      await driver.dispose();
    }
  });

  test('assistant event carries demo echo text', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('hello-tui', (e) => events.push(e));
      const assistant = events.find((e) => e.type === 'assistant');
      expect(assistant).toBeTruthy();
      const content = (
        (assistant as Extract<AgentEvent, { type: 'assistant' }>).message.payload as {
          content?: Array<{ type: string; text?: string }>;
        }
      )?.content;
      const text = (content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      expect(text).toContain('forgeax-cli(demo)');
      expect(text).toContain('hello-tui');
    } finally {
      await driver.dispose();
    }
  });

  test('done terminal is reached (turn completes)', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('ping', (e) => events.push(e));
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeTruthy();
    } finally {
      await driver.dispose();
    }
  });

  test('driver surface (model / allowAlways / setMode / setAskUser / abort) callable without throwing', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      expect(driver.model).toBe('claude-opus-4-8');
      expect(() => driver.setMode('default')).not.toThrow();
      expect(() => driver.setAskUser(async () => true)).not.toThrow();
      expect(() => driver.allowAlways('Bash')).not.toThrow();
      // abort 无在飞轮时安全 no-op(agent 尚未构造)。
      expect(() => driver.abort('test')).not.toThrow();
    } finally {
      await driver.dispose();
    }
  });

  test('abort still targets the in-flight agent after async model rebuild clears current agent', async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const provider: LLMProvider = {
      api: 'blocking',
      async *stream(_req, opts): AsyncIterable<ProviderStreamEvent> {
        markEntered();
        await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    };
    const host = await buildHostContext({ ...ARGS }, provider);
    const driver = createAgentDriver({ ...ARGS, providerOverride: provider }, host);
    try {
      const events: AgentEvent[] = [];
      const running = driver.driveTurn('wait', (event) => events.push(event));
      await entered;
      driver.setModel('claude-sonnet-4-5');
      // buildHostContext(providerOverride) 只含同步/本地装配；让 its promise callback 清 agent。
      await new Promise((resolve) => setTimeout(resolve, 0));
      driver.abort('test');
      await running;
      const done = events.at(-1);
      expect(done?.type === 'done' && done.terminal.reason).toBe('aborted_streaming');
    } finally {
      await driver.dispose();
    }
  });
});

describe('permission mode sync — getMode / initialMode / ExitPlanMode 回读', () => {
  test('initialMode 播种 driver;setMode/getMode/status/rules 视图一致', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS, initialMode: 'acceptEdits' }, host);
    try {
      expect(driver.getMode()).toBe('acceptEdits');
      expect(driver.getStatus().permissionMode).toBe('acceptEdits');
      driver.setMode('plan');
      expect(driver.getMode()).toBe('plan');
      expect(driver.getPermissionRules().mode).toBe('plan');
      expect(driver.getStatus().permissionMode).toBe('plan');
    } finally {
      await driver.dispose();
    }
  });

  test('未传 initialMode → 缺省 default(回归)', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      expect(driver.getMode()).toBe('default');
    } finally {
      await driver.dispose();
    }
  });

  test('ExitPlanMode 人类闸放行 → driver 回读恢复的 pre-plan 模式(不再停在 plan)', async () => {
    const provider = scriptedProvider([
      [asstText('turn1 done')], // 轮1:建 agent(mode=acceptEdits)
      [asstToolUse('e1', 'ExitPlanMode', { plan: 'p' })], // 轮2:plan 下模型请求退出
      [asstText('turn2 done')],
    ]);
    const host = await buildHostContext({ ...ARGS }, provider);
    const driver = createAgentDriver({ ...ARGS, providerOverride: provider, initialMode: 'acceptEdits' }, host);
    try {
      driver.setAskUser(async () => true); // 人类 approve 出口闸
      await driver.driveTurn('warm up', () => {});
      driver.setMode('plan'); // 活 agent 上切 plan → CoreAgent 记录 prePlanMode=acceptEdits
      expect(driver.getMode()).toBe('plan');
      await driver.driveTurn('exit please', () => {});
      // ExitPlanMode 在轮内恢复 acceptEdits;driveTurn 收尾回读,driver 不再漂移。
      expect(driver.getMode()).toBe('acceptEdits');
      expect(driver.getStatus().permissionMode).toBe('acceptEdits');
    } finally {
      await driver.dispose();
    }
  });
});
