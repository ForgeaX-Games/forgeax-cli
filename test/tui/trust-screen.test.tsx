/**
 * TrustDialog(src/tui/screens/Trust.tsx)—— ink-testing-library 真渲染:
 * 两选项 + 文案渲染、数字/方向键选中、Enter 接受、Esc → exit 决策、home 目录警告行。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { homedir } from 'node:os';
import { TrustDialog } from '../../src/tui/screens/Trust';
import { TRUST_TITLE, TRUST_HOME_WARNING } from '../../src/cli/trust';

const CWD = '/tmp/some-project';
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('TrustDialog', () => {
  test('renders title, cwd, both options and hint line', () => {
    const { lastFrame } = render(<TrustDialog cwd={CWD} onDecision={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(TRUST_TITLE);
    expect(frame).toContain(CWD);
    expect(frame).toContain('1. Yes, I trust this folder');
    expect(frame).toContain('2. No, exit');
    expect(frame).toContain('Enter 确认');
    expect(frame).not.toContain(TRUST_HOME_WARNING); // 非 home 目录无警告行
  });

  test('home directory shows the dim warning line', () => {
    const { lastFrame } = render(<TrustDialog cwd={homedir()} onDecision={() => {}} />);
    expect(lastFrame()).toContain(TRUST_HOME_WARNING);
  });

  test('Enter on default option (Yes) → trusted=true', async () => {
    let decision: boolean | undefined;
    const { stdin } = render(<TrustDialog cwd={CWD} onDecision={(t) => (decision = t)} />);
    await tick();
    stdin.write('\r');
    await tick();
    expect(decision).toBe(true);
  });

  test('arrow down to "No, exit" then Enter → trusted=false', async () => {
    let decision: boolean | undefined;
    const { stdin, lastFrame } = render(
      <TrustDialog cwd={CWD} onDecision={(t) => (decision = t)} />,
    );
    await tick();
    stdin.write('[B'); // ↓
    await tick();
    expect(lastFrame()).toContain('❯ 2. No, exit'); // 高亮移到第二项
    stdin.write('\r');
    await tick();
    expect(decision).toBe(false);
  });

  test('digit 2 selects directly → trusted=false; digit 1 → true', async () => {
    let decision: boolean | undefined;
    const r1 = render(<TrustDialog cwd={CWD} onDecision={(t) => (decision = t)} />);
    await tick();
    r1.stdin.write('2');
    await tick();
    expect(decision).toBe(false);

    decision = undefined;
    const r2 = render(<TrustDialog cwd={CWD} onDecision={(t) => (decision = t)} />);
    await tick();
    r2.stdin.write('1');
    await tick();
    expect(decision as boolean | undefined).toBe(true);
  });

  test('Esc → trusted=false (cc onCancel → exit)', async () => {
    let decision: boolean | undefined;
    const { stdin } = render(<TrustDialog cwd={CWD} onDecision={(t) => (decision = t)} />);
    await tick();
    stdin.write('');
    await tick();
    expect(decision).toBe(false);
  });
});
