/**
 * 验收 03 补充证据 —— driver 层数值口径(03.4/03.18/03.19)+ 空闲 ctrl-c 退出(03.11)
 * + slash file 命令 busy 中入队(03.17)。
 *
 * driver 层用可控慢 provider 直驱 createAgentDriver(不经 App),精确观测:
 *   - getContextTokens 生成期 = ctxPromptTokens + ceil(liveOutChars/4),静默回落纯 input+cache(03.4)
 *   - 上下文占用跨轮取最近请求、非累计(03.18)
 *   - usageAcc 逐 assistant 收尾累加、跨轮叠加(03.19)
 * 空闲 ctrl-c 退出用真实 <App> + waitUntilExit(03.11)。
 * file 命令入队用真实 <App> + tmp `.forgeax/commands/foo.md` + registerFileCommands(03.17)。
 *
 * 纯本地、离线。仅验证证据,非生产代码。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';
import { registerFileCommands } from '../../src/tui/commands/file-commands';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';

const MODEL = 'claude-opus-4-8';
const CR = '\r';
const CTRL_C = '\x03';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可控慢 provider(与主 e2e 同款):卡闸门直到 release。 */
function makeCtl() {
  let calls = 0;
  const gates: Array<() => void> = [];
  const provider: LLMProvider = {
    api: 'ctl',
    async *stream(req, opts): AsyncIterable<ProviderStreamEvent> {
      calls++;
      const last = req.messages.at(-1);
      const userText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      yield { type: 'message_start', usage: { inputTokens: 100, cacheReadInputTokens: 0 } };
      yield { type: 'content_block_delta', index: 0, delta: { text: 'abcdefghijk' } }; // 11 chars
      await new Promise<void>((resolve, reject) => {
        if (opts.signal.aborted) return reject(new Error('aborted'));
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        gates.push(resolve);
      });
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `REPLY[${userText}]` }] },
        usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, calls: () => calls, releaseAll: () => gates.splice(0).forEach((f) => f()) };
}

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'verify03d-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('03 driver-level numeric truth', () => {
  test('03.4/03.18/03.19 token 随流平滑涨/静默回落 · 上下文非累计 · usage 跨轮叠加', async () => {
    const c = makeCtl();
    const opts = { model: MODEL, demo: true, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
    const host = await buildHostContext({ ...opts }, c.provider);
    const driver = createAgentDriver({ ...opts, providerOverride: c.provider }, host);
    try {
      // ── 轮 1:起跑(不 await),卡在闸门时观测在飞 token ──
      const t1 = driver.driveTurn('one', () => {});
      await sleep(150); // message_start + delta 已到,卡闸门
      // 03.4 生成期:ctxPromptTokens(100) + ceil(11/4)=3 = 103
      expect(driver.getContextTokens()).toBe(103);
      c.releaseAll();
      await t1;
      // 03.4 静默:assistant 收尾重置 liveOutChars → 纯 input+cache = 100
      expect(driver.getContextTokens()).toBe(100);
      // 03.19 一轮后 usageAcc.output = 20
      expect(driver.getUsage().outputTokens).toBe(20);

      // ── 轮 2:再跑一轮 ──
      const t2 = driver.driveTurn('two', () => {});
      await sleep(150);
      expect(driver.getContextTokens()).toBe(103); // 又是 100 + 3(非累计:不是 200+)
      c.releaseAll();
      await t2;
      // 03.18 上下文占用取最近请求,仍为 100(非把两轮历史累加成 ~200)
      expect(driver.getContextTokens()).toBe(100);
      // 03.19 计费累计跨轮叠加:两轮 output = 40
      expect(driver.getUsage().outputTokens).toBe(40);
      expect(driver.getUsage().inputTokens).toBe(200); // 计费 input 逐请求累加(2×100)
    } finally {
      c.releaseAll();
      await driver.dispose();
    }
  }, 30_000);
});

describe('03 App-level: idle ctrl-c exit & file-command enqueue', () => {
  test('03.11 空闲态 ctrl-c 退出(app 停止响应,后续输入不再起轮)', async () => {
    // ink-testing-library 不暴露 waitUntilExit,故行为化证明:空闲 ctrl-c → interrupt() 见 busy=false
    // → exit() 拆掉 app;此后再提交消息**不会**起新轮(useInput 已随 unmount 移除)。
    // 对照:其它用例已证明「空闲提交必起一轮」(如 03.8 首轮),故此处 calls 恒 0 即 exit 生效证据。
    const c = makeCtl();
    const opts = { model: MODEL, demo: true, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
    const host = await buildHostContext({ ...opts }, c.provider);
    const driver = createAgentDriver({ ...opts, providerOverride: c.provider }, host);
    const controller = createRemoteController(() => createFakeChannel());
    const r = render(React.createElement(App, { driver, controller }));
    try {
      await sleep(150); // 空闲(无在飞轮)
      r.stdin.write(CTRL_C); // 空闲 ctrl-c → exit()
      await sleep(200);
      // 退出后再提交:app 已拆,不应起任何轮
      r.stdin.write('after-exit');
      await sleep(60);
      r.stdin.write(CR);
      await sleep(200);
      expect(c.calls()).toBe(0); // 全程零轮 → ctrl-c 确实退出(而非留在 REPL)
    } finally {
      c.releaseAll();
      try { r.unmount(); } catch { /* already exited */ }
      await driver.dispose();
    }
  }, 30_000);

  test('03.17 slash file 命令 busy 中入队 → 轮结束跑展开正文', async () => {
    // tmp `.forgeax/commands/foo.md`(无 frontmatter → user-invocable),正文含唯一标记。
    mkdirSync(join(tmp, '.forgeax/commands'), { recursive: true });
    writeFileSync(join(tmp, '.forgeax/commands/foo.md'), 'ZZFOOMARKERZZ body text\n');
    registerFileCommands(undefined, undefined); // 注册 file 指令 provider(读 cwd/.forgeax/commands)

    const c = makeCtl();
    const opts = { model: MODEL, demo: true, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' } as const;
    const host = await buildHostContext({ ...opts }, c.provider);
    const driver = createAgentDriver({ ...opts, providerOverride: c.provider }, host);
    const controller = createRemoteController(() => createFakeChannel());
    const r = render(React.createElement(App, { driver, controller }));
    const frame = () => r.lastFrame() ?? '';
    try {
      await sleep(150);
      // 起一轮占 busy
      r.stdin.write('start');
      await sleep(60);
      r.stdin.write(CR);
      await sleep(150);
      expect(c.calls()).toBe(1);

      // busy 中提交 /foo(file 命令)→ 应入队(展开正文),不立即跑
      r.stdin.write('/foo');
      await sleep(80);
      r.stdin.write(CR);
      await sleep(150);
      expect(c.calls()).toBe(1); // 未起新轮(入队)
      expect(frame()).toContain('/foo'); // transcript 显示用户敲的 /foo(非展开正文)

      // 放行 → 消费队列,跑的是展开正文(REPLY 含标记)
      c.releaseAll();
      await sleep(250);
      expect(c.calls()).toBe(2);
      c.releaseAll();
      await sleep(250);
      expect(frame()).toContain('ZZFOOMARKERZZ'); // 展开正文作一轮 user 输入被跑
    } finally {
      c.releaseAll();
      try { r.unmount(); } catch { /* noop */ }
      await driver.dispose();
    }
  }, 30_000);
});
