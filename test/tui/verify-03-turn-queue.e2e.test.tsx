/**
 * 验收 03-轮次生命周期与队列 —— 真实 <App>(Ink)+ 可控慢 provider 的行为证据。
 *
 * demo provider 是瞬时 echo,观察不到 busy 窗口;本 harness 注入一个「可控慢 provider」:
 * 它先发 message_start(带 input usage)+ 一段 content_block_delta(text),然后**卡在一个
 * 外部可释放的闸门**上,直到 release() 才发终局 assistant。abort 时(signal.aborted)在等待处
 * 抛出 → agent 走 turn_aborted + done('aborted_streaming')。
 *
 * 这样就能在「turn 在飞(busy)」的真实窗口里驱动键盘:排队、FIFO 消费、esc/ctrl-c 打断、
 * 二次 esc 不重复 abort、打断后再发消息立即跑、队列裁剪展示、远端来源入队回执。
 *
 * ⚠️ 键入与回车必须分两次 write 且中间留延时:Ink 会把 'text\r' 一次到达的字节当粘贴处理,
 * 不触发提交。故用 submit(app, text) 封装:write(text) → sleep → write(CR) → sleep。
 *
 * 纯本地、离线(不打网络)。chdir tmp 隔离会话 WAL。仅验证证据,非生产代码。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel, type FakeChannel } from '../../src/tui/remote/fake-channel';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';
import type { AgentDriver } from '../../src/tui/contracts';

const MODEL = 'claude-opus-4-8';
const CR = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AppHandle = {
  created: FakeChannel[];
  controller: ReturnType<typeof createRemoteController>;
  frame: () => string;
  stdin: { write(s: string): void };
  unmount: () => void;
};

/** 键入文本并提交(分两次 write + 延时,避开 Ink 的粘贴聚合)。 */
async function submit(app: AppHandle, text: string): Promise<void> {
  app.stdin.write(text);
  await sleep(60);
  app.stdin.write(CR);
  await sleep(150);
}

/** 可控慢 provider:每次 stream 记一次调用;卡在 release 闸门直到外部放行,abort 则抛。 */
function makeControllableProvider(abortSettleMs = 0): {
  provider: LLMProvider;
  calls: () => number;
  aborts: () => number;
  releaseAll: () => void;
} {
  let callCount = 0;
  let abortCount = 0;
  const gates: Array<() => void> = [];
  const provider: LLMProvider = {
    api: 'controllable',
    async *stream(req, opts): AsyncIterable<ProviderStreamEvent> {
      callCount++;
      const last = req.messages.at(-1);
      const userText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      yield { type: 'message_start', usage: { inputTokens: 100, cacheReadInputTokens: 0 } };
      yield { type: 'content_block_delta', index: 0, delta: { text: 'thinking...' } };
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          abortCount++;
          if (abortSettleMs > 0) setTimeout(() => reject(new Error('aborted')), abortSettleMs);
          else reject(new Error('aborted'));
        };
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
        gates.push(() => {
          opts.signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `REPLY[${userText}]` }] },
        usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return {
    provider,
    calls: () => callCount,
    aborts: () => abortCount,
    releaseAll: () => gates.splice(0).forEach((fn) => fn()),
  };
}

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'verify03-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mountApp(
  provider: LLMProvider,
  decorateDriver?: (driver: AgentDriver) => AgentDriver,
): Promise<AppHandle> {
  const opts = { model: MODEL, demo: true, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
  const host = await buildHostContext({ ...opts }, provider);
  const baseDriver = createAgentDriver({ ...opts, providerOverride: provider }, host);
  const driver = decorateDriver?.(baseDriver) ?? baseDriver;
  const created: FakeChannel[] = [];
  const controller = createRemoteController(() => {
    const c = createFakeChannel();
    created.push(c);
    return c;
  });
  const r = render(React.createElement(App, { driver, controller }));
  return { created, controller, frame: () => r.lastFrame() ?? '', stdin: r.stdin, unmount: r.unmount };
}

describe('03-轮次生命周期与队列 (real App + controllable slow provider)', () => {
  test('用户消息先于同步 checkpoint 和 provider 启动上屏', async () => {
    const c = makeControllableProvider();
    let checkpointStarted = false;
    let frameAtCheckpoint = '';
    let currentFrame = () => '';
    const app = await mountApp(c.provider, (driver) => ({
      ...driver,
      checkpointTurn(msgId?: string) {
        checkpointStarted = true;
        frameAtCheckpoint = currentFrame();
        return driver.checkpointTurn(msgId);
      },
    }));
    currentFrame = app.frame;
    try {
      await sleep(150);
      app.stdin.write('paint-first');
      await sleep(60);
      app.stdin.write(CR);

      // startUserTurn 先 push,再 setImmediate 让 Ink commit,之后 checkpoint 才会开始。
      await sleep(20);
      expect(checkpointStarted).toBe(true);
      expect(frameAtCheckpoint).toContain('paint-first');
      expect(app.frame()).toContain('paint-first');
      expect(c.calls()).toBe(1);
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.6/03.7/03.15 busy 入队 → 队列裁剪展示 → 轮结束 FIFO 顺序消费', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'first'); // turn 1 起跑(卡闸门 → busy)
      await sleep(150);
      expect(c.calls()).toBe(1);

      await submit(app, 'A'); // busy 中排队 A
      const longMsg = 'B' + 'x'.repeat(120); // 超长 → 裁剪
      await submit(app, longMsg);
      await sleep(120);

      expect(c.calls()).toBe(1); // 排队未起新轮
      const busyFrame = app.frame();
      expect(busyFrame).toContain('... 1. A');
      expect(busyFrame).toMatch(/\.\.\. 2\. Bx+\.\.\./); // 尾部截断标记
      const qline = busyFrame.split('\n').find((l) => l.includes('... 2. Bx'))!;
      expect(qline.trim().length).toBeLessThanOrEqual(88); // 单行裁剪不刷屏

      c.releaseAll(); // 放行 turn 1 → A 起跑
      await sleep(250);
      expect(c.calls()).toBe(2);
      c.releaseAll(); // A 结束 → B 起跑
      await sleep(250);
      expect(c.calls()).toBe(3);
      c.releaseAll(); // B 结束
      await sleep(250);
      expect(app.frame()).not.toContain('... 1.'); // 队列清空
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.9/03.13/03.14 busy 单击 esc 打断 → 标记复位 → 再发消息立即跑且可再打断', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'long-turn');
      await sleep(150);
      expect(c.calls()).toBe(1);

      app.stdin.write(ESC); // 单击 esc → 打断在飞轮
      await sleep(250);
      expect(c.aborts()).toBe(1);
      expect(app.frame()).toContain('已中断'); // reduce.ts aborted → warn「已中断」

      await submit(app, 'after'); // 打断后 busy=false → 立即起新轮(不入队)
      await sleep(150);
      expect(c.calls()).toBe(2);
      app.stdin.write(ESC); // 标记已复位 → 第二轮同样可打断
      await sleep(200);
      expect(c.aborts()).toBe(2);
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('busy 普通菜单内 esc 不被浮层吞掉,立即显示中断回执并 abort', async () => {
    // 延迟 provider 的 abort 收尾,把「按键已接收」与终局 done 拉开,证明回执不是终局事件带来的。
    const c = makeControllableProvider(400);
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'turn');
      expect(c.calls()).toBe(1);

      app.stdin.write('/'); // busy 时仍可打开 command-menu
      await sleep(80);
      expect(app.frame()).toContain('/agents');

      app.stdin.write(ESC);
      await sleep(80);
      expect(c.aborts()).toBe(1);
      expect(app.frame()).toContain('正在中断');
      expect(app.frame()).not.toContain('已中断'); // provider 尚未 settle,终局 notice 还未到
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.12 同一轮内二次 esc 不重复 abort(interruptedRef 守门)', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'turn');
      await sleep(150);
      expect(c.calls()).toBe(1);
      app.stdin.write(ESC);
      await sleep(40);
      app.stdin.write(ESC); // 同一轮内再按
      await sleep(250);
      expect(c.aborts()).toBe(1); // 仅一次 abort
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.10 busy 态 ctrl-c 打断在飞轮(不退出)', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'turn');
      await sleep(150);
      expect(c.calls()).toBe(1);
      app.stdin.write(CTRL_C);
      await sleep(250);
      expect(c.aborts()).toBe(1);
      await submit(app, 'again'); // 未退出:仍能起新轮
      await sleep(150);
      expect(c.calls()).toBe(2);
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.8 空队列轮结束不误触发新轮', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await submit(app, 'solo');
      await sleep(150);
      expect(c.calls()).toBe(1);
      c.releaseAll(); // 不排队,直接放行结束
      await sleep(300);
      expect(c.calls()).toBe(1); // 队列空 → 不再起轮
      expect(app.frame()).toContain('REPLY[solo]');
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('03.16 远端来源 busy 入队带 origin → 消费时回复定址回对端', async () => {
    const c = makeControllableProvider();
    const app = await mountApp(c.provider);
    try {
      await sleep(150);
      await app.controller.addAccount('fake');
      const ch = app.created[0]!;
      ch.simulateLogin();
      await submit(app, 'local'); // 本地起一轮占 busy
      await sleep(150);
      expect(c.calls()).toBe(1);

      const peer = { id: 'wx-bob', name: 'Bob' };
      ch.simulateInbound(peer, 'remote-hi'); // 远端来 → 入队(带 origin)
      await sleep(150);
      expect(c.calls()).toBe(1);
      expect(app.frame()).toContain('[微信:Bob] remote-hi');

      c.releaseAll(); // 放行本地轮 → 消费远端队列项
      await sleep(250);
      expect(c.calls()).toBe(2);
      c.releaseAll();
      await sleep(300);
      expect(ch.sent.length).toBeGreaterThanOrEqual(1);
      expect(ch.sent.at(-1)!.peer).toEqual(peer);
      expect(ch.sent.at(-1)!.text).toContain('REPLY[remote-hi]');
    } finally {
      c.releaseAll();
      app.unmount();
    }
  }, 30_000);
});
