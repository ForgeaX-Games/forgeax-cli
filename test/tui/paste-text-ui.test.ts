/** 多行文本粘贴在编辑时折叠，提交后 transcript 展开为原文。 */
import { test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('提交多行粘贴后显示原始内容而不是折叠占位', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'forgeax-paste-text-'));
  const opts = {
    model: 'claude-opus-4-8',
    demo: true,
    sessionsDir: join(tmp, '.forgeax/sessions'),
    sessionId: 'paste-text',
  } as const;
  const host = await buildHostContext(opts);
  const driver = createAgentDriver(opts, host);
  const controller = createRemoteController(() => createFakeChannel());
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { driver, controller }));

  try {
    await sleep(60);
    stdin.write('\x1b[200~first pasted line\nsecond pasted line\x1b[201~');
    await sleep(50);
    expect(lastFrame()).toContain('[Pasted text #1 +2 lines]');

    stdin.write('\r');
    await sleep(250);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('first pasted line');
    expect(frame).toContain('second pasted line');
    expect(frame).not.toContain('[Pasted text #1 +2 lines]');
  } finally {
    unmount();
    await driver.dispose();
    rmSync(tmp, { recursive: true, force: true });
  }
});
