/**
 * F2 回归证据 —— LiveThinking(在飞流式 thinking 呈现)。
 *
 *   - 有 thinking 文本 → 渲染流式内容 + 「thinking…」头(cc 语义的「先显示」那一半;
 *     轮末折叠那一半由转录区 ThinkingView 覆盖,见 views.test)。
 *   - 空文本 → 不渲染(null),不占屏。
 *   - 超长 → 只显示尾部若干行,前部以 `…` 截断标记,避免动态区超屏弹跳。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { LiveThinking } from '../../src/tui/components/LiveThinking';

describe('F2 LiveThinking', () => {
  test('渲染流式 thinking 文本 + 头部提示', () => {
    const { lastFrame } = render(<LiveThinking text={'weighing option A\nthen option B'} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('weighing option A');
    expect(frame).toContain('then option B');
  });

  test('空文本 → 不渲染任何内容', () => {
    const { lastFrame } = render(<LiveThinking text={'   \n  '} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  test('超长 → 尾部截断,保留最后的行、丢最早的行', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<LiveThinking text={lines.join('\n')} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line-29'); // 最后一行必在
    expect(frame).not.toContain('line-0\n'); // 最早的行被截掉
    expect(frame).toContain('…'); // 截断标记
  });
});
