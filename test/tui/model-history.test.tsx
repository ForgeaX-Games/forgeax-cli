/**
 * /model 与输入历史的集成回归。
 *
 * 历史允许保存 slash 命令；从模型选择器返回后，第一次 ↑ 会回显最近的 `/model`。
 * 此时不能立刻重新打开命令菜单，否则第二次 ↑ 会被菜单导航吞掉，无法继续翻历史。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { App } from '../../src/tui/app';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFrame(
  app: ReturnType<typeof render>,
  predicate: (frame: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(app.lastFrame() ?? '')) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for frame:\n${app.lastFrame() ?? ''}`);
}

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'repl-model-history-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('/model input history (full App)', () => {
  test('模型选择后可越过历史中的 /model 继续向上翻', async () => {
    const opts = {
      model: 'claude-opus-4-8',
      demo: true,
      sessionsDir: join(tmp, '.forgeax/sessions'),
      sessionId: 's1',
    } as const;
    const host = await buildHostContext(opts);
    const driver = createAgentDriver(opts, host);
    const controller = createRemoteController(() => createFakeChannel());
    const app = render(React.createElement(App, { driver, controller }));

    try {
      await sleep(80);
      app.stdin.write('history-before-model');
      await sleep(40);
      app.stdin.write(ENTER);
      await sleep(250); // demo turn 完成，历史已记录

      app.stdin.write('/model');
      await sleep(40);
      app.stdin.write(ENTER); // 打开 model picker
      await waitForFrame(app, (frame) => frame.includes('选择模型'));
      // 模型表在 effect 中异步装载；等候选项出现后 Enter 才会选中并关闭 picker。
      await waitForFrame(
        app,
        (frame) => frame.includes('claude-opus-4-8') && !frame.includes('正在获取可用模型列表'),
      );
      await sleep(20); // 等候 loading→列表 的渲染 effects 与 input handler 稳定
      app.stdin.write(ENTER); // 选择当前高亮模型并返回 prompt
      await waitForFrame(app, (frame) => frame.includes('输入消息'));
      await sleep(20); // 等 model-picker→prompt 后 useInput 订阅切到最新 mode

      app.stdin.write(UP); // 最近一条是 /model
      await waitForFrame(app, (frame) => frame.includes('/model'));
      expect(app.lastFrame()).toContain('/model');
      // 历史回显的 slash 命令不应重新占用 command-menu mode。
      expect(app.lastFrame()).not.toContain('切换 LLM 模型(下一轮生效)');

      app.stdin.write(UP); // 必须继续交给 history，而不是移动命令菜单高亮
      await waitForFrame(
        app,
        // transcript 的 user + demo reply 已各含一次；第三次来自当前 prompt。
        (frame) => (frame.match(/history-before-model/g)?.length ?? 0) >= 3,
      );

      app.stdin.write(DOWN); // 向下也仍由 history 接管，回到 /model
      await waitForFrame(
        app,
        (frame) =>
          frame.includes('/model') &&
          (frame.match(/history-before-model/g)?.length ?? 0) === 2,
      );
      expect(app.lastFrame()).not.toContain('切换 LLM 模型(下一轮生效)');
    } finally {
      app.unmount();
      await driver.dispose();
      await controller.dispose();
    }
  });
});
