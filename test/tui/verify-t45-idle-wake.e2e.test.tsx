/**
 * 验收 T4.5-idle 自动唤醒 —— 真实 <App>(Ink)+ 可观测 provider 的行为证据。
 *
 * T4 是被动注入(通知躺队列等下一次用户说话);T4.5 让后台任务完成时,若轮串行器
 * idle(无在飞轮/无排队/无浮层/用户没打字)则**主动 drain 合成一轮**自动续接。
 * 本文件按 todo 011 的护栏清单逐条取证:
 *   ① idle 唤醒:enqueue → 自动起一轮,请求体含 <task_notification>,transcript 出 notice;
 *   ② 多任务合并:连发两条通知只起一轮,两条都在块里;
 *   ③ busy 让位:在飞轮期间通知不抢跑;轮结束后链式唤醒;
 *   ④ 打字让位:输入框非空不唤醒;清空后补唤醒;
 *   ⑤ 深度上限:连续自动唤醒链长封顶 MAX_WAKE_CHAIN(5),超出留 pending;
 *      用户输入 → T4 UserPromptSubmit 注入兜底 drain + 链深归零,唤醒恢复。
 *
 * 通知注入走 host.taskNotifications.enqueue(与真实观察侧同一入口——wrapBackgroundSpawn/
 * onSubagentDone 最终都调它),不依赖真后台进程,纯本地离线。chdir tmp 隔离会话 WAL。
 *
 * ⚠️ 键入与回车分两次 write + 延时(Ink 粘贴聚合,同 verify-03)。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext, type HostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';

const MODEL = 'claude-opus-4-8';
const CR = '\r';
const BS = '\x7f';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AppHandle = {
  host: HostContext;
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

/** 可观测 provider:记录每次 stream 的末条 user 文本;可选闸门(gated=true 时卡到 release)。 */
function makeRecordingProvider(gated = false): {
  provider: LLMProvider;
  calls: () => number;
  userTexts: string[];
  releaseAll: () => void;
} {
  let callCount = 0;
  const userTexts: string[] = [];
  const gates: Array<() => void> = [];
  const provider: LLMProvider = {
    api: 'recording',
    async *stream(req, opts): AsyncIterable<ProviderStreamEvent> {
      callCount++;
      const last = req.messages.at(-1);
      const userText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      userTexts.push(userText);
      yield { type: 'message_start', usage: { inputTokens: 100, cacheReadInputTokens: 0 } };
      yield { type: 'content_block_delta', index: 0, delta: { text: 'ok' } };
      if (gated) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (opts.signal.aborted) return onAbort();
          opts.signal.addEventListener('abort', onAbort, { once: true });
          gates.push(() => {
            opts.signal.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      }
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `REPLY#${callCount}` }] },
        usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, calls: () => callCount, userTexts, releaseAll: () => gates.splice(0).forEach((fn) => fn()) };
}

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'verify-t45-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mountApp(provider: LLMProvider): Promise<AppHandle> {
  const opts = { model: MODEL, demo: true, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
  const host = await buildHostContext({ ...opts }, provider);
  const driver = createAgentDriver({ ...opts, providerOverride: provider }, host);
  const controller = createRemoteController(() => createFakeChannel());
  const r = render(React.createElement(App, { driver, controller }));
  return { host, frame: () => r.lastFrame() ?? '', stdin: r.stdin, unmount: r.unmount };
}

describe('T4.5-idle 自动唤醒 (real App + recording provider)', () => {
  test('① idle 时后台完成 → 自动起一轮,请求含 <task_notification>,transcript 出 notice', async () => {
    const p = makeRecordingProvider();
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      expect(p.calls()).toBe(0); // 挂载后静默:无用户输入不起轮
      app.host.taskNotifications.enqueue({ label: 'sleep 5 && echo done', status: 'exit code 0', outputTail: 'done' });
      await sleep(300);
      expect(p.calls()).toBe(1); // 自动唤醒起了一轮
      expect(p.userTexts[0]).toContain('<task_notification>');
      expect(p.userTexts[0]).toContain('sleep 5 && echo done');
      expect(p.userTexts[0]).toContain('exit code 0');
      const f = app.frame();
      expect(f).toContain('后台任务'); // 完成 notice(带命令与退出态,入队即上屏)
      expect(f).toContain('exit code 0');
      expect(f).toContain('自动续接'); // 唤醒轮标注
      expect(f).toContain('REPLY#1'); // 唤醒轮的模型回复已渲染
    } finally {
      app.unmount();
    }
  }, 30_000);

  test('② 多任务合并:唤醒前攒下的多条通知 → 单轮携带全部', async () => {
    const p = makeRecordingProvider();
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      // 同步连 enqueue 两条:第一条触发的唤醒 effect 在下一拍才跑,届时 drain 全部。
      app.host.taskNotifications.enqueue({ label: 'task-A', status: 'exit code 0' });
      app.host.taskNotifications.enqueue({ label: 'task-B', status: 'exit code 1' });
      await sleep(300);
      expect(p.calls()).toBe(1); // 只起一轮
      expect(p.userTexts[0]).toContain('task-A');
      expect(p.userTexts[0]).toContain('task-B');
      expect(app.host.taskNotifications.size).toBe(0);
    } finally {
      app.unmount();
    }
  }, 30_000);

  test('③ busy 让位:在飞轮期间不抢跑;轮结束后链式唤醒', async () => {
    const p = makeRecordingProvider(true); // 闸门卡住在飞轮
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      await submit(app, 'user-turn'); // turn 1 起跑(卡闸门 → busy)
      await sleep(150);
      expect(p.calls()).toBe(1);
      app.host.taskNotifications.enqueue({ label: 'bg-during-busy', status: 'exit code 0' });
      await sleep(250);
      expect(p.calls()).toBe(1); // busy → 不抢跑,通知留 pending
      expect(app.host.taskNotifications.size).toBe(1);
      p.releaseAll(); // turn 1 结束 → idle → 唤醒
      await sleep(400);
      expect(p.calls()).toBe(2);
      expect(p.userTexts[1]).toContain('bg-during-busy');
      p.releaseAll(); // 放行唤醒轮
      await sleep(200);
    } finally {
      p.releaseAll();
      app.unmount();
    }
  }, 30_000);

  test('⑥ 运行中感知:spawn 起 → 状态栏「N 个后台 shell」常驻;退出 → 完成 notice + 计数消失', async () => {
    const p = makeRecordingProvider();
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      // 经 hub 的真实观察侧(wrapBackgroundSpawn)模拟后台 shell 起跑/退出。
      let sink: ((c: { stream: string; data: string }) => void) | null = null;
      const wrapped = app.host.taskNotifications.wrapBackgroundSpawn((_c, _a, _o, onChunk) => {
        sink = onChunk as (c: { stream: string; data: string }) => void;
        return { kill: () => {} };
      });
      wrapped('sh', ['-c', 'sleep 99'], undefined, () => {});
      await sleep(200);
      expect(app.frame()).toContain('1 个后台 shell'); // idle 期间状态栏常驻可见(静态标签,无计时)
      sink!({ stream: 'exit', data: '0' });
      await sleep(300);
      const f = app.frame();
      expect(f).not.toContain('个后台 shell'); // 退出归零即消失
      expect(f).toContain('后台任务 sleep 99 完成(exit code 0)'); // 完成 notice 即时上屏(渲染层剥反引号)
      expect(f).toContain('REPLY#1'); // 且触发了唤醒轮
    } finally {
      app.unmount();
    }
  }, 30_000);

  test('④ 打字让位:输入框非空不唤醒;清空后补唤醒', async () => {
    const p = makeRecordingProvider();
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      app.stdin.write('draft'); // 用户在打字(未提交)
      await sleep(100);
      app.host.taskNotifications.enqueue({ label: 'bg-while-typing', status: 'exit code 0' });
      await sleep(300);
      expect(p.calls()).toBe(0); // 让位:不打断输入
      expect(app.host.taskNotifications.size).toBe(1);
      for (let i = 0; i < 5; i++) {
        app.stdin.write(BS); // 逐字删空
        await sleep(30);
      }
      await sleep(300);
      expect(p.calls()).toBe(1); // 输入清空 → 补唤醒
      expect(p.userTexts[0]).toContain('bg-while-typing');
    } finally {
      app.unmount();
    }
  }, 30_000);

  test('⑤ 深度上限:链长封顶后留 pending;用户输入 → T4 注入兜底 + 链深归零', async () => {
    const p = makeRecordingProvider();
    const app = await mountApp(p.provider);
    try {
      await sleep(200);
      // 连续 5 轮自动唤醒(每轮 enqueue → 等唤醒轮跑完 → 再 enqueue,模拟唤醒轮里
      // 又起后台任务的链):都应该跑。
      for (let i = 1; i <= 5; i++) {
        app.host.taskNotifications.enqueue({ label: `chain-${i}`, status: 'exit code 0' });
        await sleep(300);
        expect(p.calls()).toBe(i);
      }
      // 第 6 条:链深已达 MAX_WAKE_CHAIN(5)→ 不再自动唤醒,留 pending。
      app.host.taskNotifications.enqueue({ label: 'chain-6-capped', status: 'exit code 0' });
      await sleep(300);
      expect(p.calls()).toBe(5);
      expect(app.host.taskNotifications.size).toBe(1);
      // 用户说话:T4 UserPromptSubmit 注入把 pending 带进该轮(hub 清空),且链深归零。
      await submit(app, 'hello');
      await sleep(300);
      expect(p.calls()).toBe(6);
      expect(app.host.taskNotifications.size).toBe(0); // T4 兜底已 drain
      // 链深已随用户输入归零 → 新通知恢复自动唤醒。
      app.host.taskNotifications.enqueue({ label: 'chain-reset-ok', status: 'exit code 0' });
      await sleep(300);
      expect(p.calls()).toBe(7);
      expect(p.userTexts[6]).toContain('chain-reset-ok');
    } finally {
      app.unmount();
    }
  }, 30_000);
});
