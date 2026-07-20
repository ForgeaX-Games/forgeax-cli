/**
 * 08.9 回归:ThinkingIndicator 不再是死代码,busy 时状态栏有 spinner + thinking 文案。
 *
 * 两层验证:
 *  1. 源码层 —— Repl.tsx 必须 import/挂载 ThinkingIndicator(证明零引用死代码已消除)。
 *  2. 渲染层 —— busy=true 输出含 "thinking";busy=false 输出为空(与 StatusLine 一致,非 busy 不占位)。
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/tui/providers/theme';
import { ThinkingIndicator, bgTaskLabel } from '../../src/tui/components/ThinkingIndicator';

describe('08.9 ThinkingIndicator mounted (no longer dead code)', () => {
  test('源码层:Repl.tsx 引用了 ThinkingIndicator', () => {
    const replPath = fileURLToPath(new URL('../../src/tui/screens/Repl.tsx', import.meta.url));
    const src = readFileSync(replPath, 'utf8');
    expect(src).toContain('ThinkingIndicator');
  });

  test('渲染层:busy=true 显示 thinking 文案', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, null, React.createElement(ThinkingIndicator, { busy: true })),
    );
    expect(lastFrame() ?? '').toContain('thinking');
  });

  test('渲染层:busy=false 不占位(输出为空)', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, null, React.createElement(ThinkingIndicator, { busy: false })),
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  test('计数标签:纯 shell 无时间 / 纯任务带时间 / 混合分列', () => {
    expect(bgTaskLabel(2, 0)).toBe('2 个后台 shell');
    expect(bgTaskLabel(2, 0, 9)).toBe('2 个后台 shell'); // shell 段永不带时间
    expect(bgTaskLabel(0, 3)).toBe('3 个后台任务');
    expect(bgTaskLabel(0, 3, 35)).toBe('3 个后台任务 (35s)');
    expect(bgTaskLabel(2, 2, 35)).toBe('2 个后台 shell | 2 个后台任务 (35s)');
    expect(bgTaskLabel(0, 0)).toBe('');
  });

  test('渲染层:idle + 混合后台任务 → 分列标签(shell 无时间,任务带时间)', () => {
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ThinkingIndicator, { busy: false, bgShells: 2, bgAgents: 2 }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 个后台 shell | 2 个后台任务 (');
  });
});
