/**
 * /remote-control 确认转发端到端:真实 <App> + 「第一轮吐 bash tool_use」的假 provider。
 *
 * 链路:远端入站消息驱动一轮 → 引擎判 'ask' → PermissionProvider enqueue → Repl 转发
 * effect 把审批卡格式化发到 FakeChannel(远端可见)→ 远端回「y p1」→ 灌回同一 decide
 * 路径 → 工具放行 → 轮完成 → 最终回复也回发远端。另验:远端回「n p1」拒绝、迟到回复
 * 收到「已失效」回执、本地轮(无远端入站前)不外发。
 *
 * 全离线。chdir tmp 隔离会话 WAL。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { resetSettingsCache } from '../../src/cli/settings';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel, type FakeChannel } from '../../src/tui/remote/fake-channel';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';

const MODEL = 'claude-opus-4-8';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE: Usage = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** 第一次调用吐 bash tool_use(触发权限 ask),之后 end_turn 文本回复。 */
function makeToolUseProvider(): LLMProvider & { calls: () => number } {
  let n = 0;
  return {
    api: 'fake-tooluse',
    calls: () => n,
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      n++;
      if (n === 1) {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'echo approved-run' } }],
          },
          usage: USAGE,
          stopReason: 'tool_use',
        };
        return;
      }
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL[done]' }] },
        usage: USAGE,
        stopReason: 'end_turn',
      };
    },
  };
}

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'remote-approval-'));
  process.chdir(tmp);
  // bash 默认 checkPermissions=allow(把闸在规则引擎),default mode 下直接放行;
  // 项目级 ask 规则强制审批 → 触发 askUser → 权限卡 + 远端转发。
  mkdirSync(join(tmp, '.forgeax'), { recursive: true });
  writeFileSync(join(tmp, '.forgeax', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
  // settings 是进程级缓存:前面任何测试文件在别的 cwd 调过 buildHostContext 都会把
  // mergedCache 焐热 → 这里刚写的项目级 ask 规则读不到、bash 直接放行、权限卡不弹。
  resetSettingsCache();
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
  resetSettingsCache(); // 别把本测试 tmp cwd 的合并结果留给后续文件
});

async function mountApp(provider: LLMProvider) {
  const opts = { model: MODEL, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
  const host = await buildHostContext({ ...opts }, provider);
  const driver = createAgentDriver({ ...opts, providerOverride: provider }, host);
  const created: FakeChannel[] = [];
  const controller = createRemoteController(() => {
    const c = createFakeChannel();
    created.push(c);
    return c;
  });
  const r = render(React.createElement(App, { driver, controller }));
  return { created, controller, frame: () => r.lastFrame() ?? '', unmount: r.unmount };
}

const PEER = { id: 'wx-alice', name: 'Alice' };

async function startRemoteTurn(app: Awaited<ReturnType<typeof mountApp>>, text = '跑个命令') {
  await sleep(120); // Repl 挂载 + 注册入站 sink
  await app.controller.addAccount('fake');
  app.created[0]!.simulateLogin();
  await sleep(60);
  app.created[0]!.simulateInbound(PEER, text);
  await sleep(250); // 轮起跑 → tool_use → ask → 转发 effect
}

describe('/remote-control 确认转发 e2e(真实 App + tool_use provider)', () => {
  test('权限卡转发到远端;远端 y → 放行 → 工具跑 → 最终回复回发', async () => {
    const provider = makeToolUseProvider();
    const app = await mountApp(provider);
    try {
      await startRemoteTurn(app);
      const ch = app.created[0]!;
      // ① 审批卡已转发(含短 id + 命令 + 回复说明)。
      const promptMsg = ch.sent.find((s) => s.text.includes('权限请求'));
      expect(promptMsg).toBeTruthy();
      expect(promptMsg!.peer).toEqual(PEER);
      expect(promptMsg!.text).toContain('p1');
      expect(promptMsg!.text).toContain('echo approved-run');
      expect(promptMsg!.text).toContain('y p1');
      // ② 本地浮层同样在弹(双端并行等待)。
      expect(app.frame()).toContain('运行 Bash 命令');
      // ③ 远端回 y p1 → decide(true) → 工具执行 → 第二轮 end_turn → 回复回发。
      ch.simulateInbound(PEER, 'y p1');
      await sleep(600);
      expect(app.frame()).not.toContain('运行 Bash 命令'); // 浮层已收
      expect(app.frame()).toContain('远端(Alice)决策:允许一次'); // 本地 transcript 标注
      const ack = ch.sent.find((s) => s.text.includes('已允许一次'));
      expect(ack).toBeTruthy();
      const final = ch.sent.find((s) => s.text.includes('FINAL[done]'));
      expect(final).toBeTruthy();
      expect(provider.calls()).toBe(2);
    } finally {
      app.unmount();
    }
  }, 15_000);

  test('远端 n → 拒绝(工具不跑,轮以 deny 收尾)', async () => {
    const provider = makeToolUseProvider();
    const app = await mountApp(provider);
    try {
      await startRemoteTurn(app);
      const ch = app.created[0]!;
      expect(ch.sent.some((s) => s.text.includes('权限请求'))).toBe(true);
      ch.simulateInbound(PEER, 'n p1');
      await sleep(600);
      expect(app.frame()).toContain('远端(Alice)决策:拒绝');
      expect(ch.sent.some((s) => s.text.includes('已拒绝'))).toBe(true);
      // deny → 工具未执行:本地 transcript 不出现 bash 执行结果(exitCode 行)。
      //   (审批卡文本本身含命令串,不能拿命令串当「执行了」的证据。)
      expect(app.frame()).not.toContain('exitCode');
    } finally {
      app.unmount();
    }
  }, 15_000);

  test('迟到/失配的确认回复 → 「已失效」回执,不落聊天轮', async () => {
    const provider = makeToolUseProvider();
    const app = await mountApp(provider);
    try {
      await startRemoteTurn(app);
      const ch = app.created[0]!;
      ch.simulateInbound(PEER, 'y p99'); // id 不匹配当前队首
      await sleep(300);
      expect(ch.sent.some((s) => s.text.includes('已失效'))).toBe(true);
      // 没被当聊天轮喂模型:provider 仍只被调了 1 次(第一轮还挂在 ask 上)。
      expect(provider.calls()).toBe(1);
      // 收尾:正常放行,避免挂起的 ask 泄漏到 unmount。
      ch.simulateInbound(PEER, 'y p1');
      await sleep(500);
    } finally {
      app.unmount();
    }
  }, 15_000);
});
