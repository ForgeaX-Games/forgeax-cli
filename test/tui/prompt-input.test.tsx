/**
 * PromptInput 渲染回归(ink-testing-library 真渲染,固定 columns=100)。
 *
 * 钉死「光标跨行后停在第一行最后面」这一类**软折行错位** bug:历史实现把每个逻辑行
 * 用 `<Box>` 并列多个 `<Text>`(prefix/before/at/after),`<Box>` 是 flex 行容器,当行
 * 长到软折行时各段各自独立折行再被 yoga 拼接 → 字符乱序/光标块被甩到首行末尾。
 * 修复后每行收敛成单个 `<Text>`(光标块用嵌套 `<Text inverse>`),整行作一个文本流折行。
 *
 * ink-testing-library 的 lastFrame 已 strip ANSI(反显块不可见),故断言落在「可见字符
 * 按折行顺序拼接后 == 原文」:错位实现会让字符乱序/重复/塞 padding,从而被本测捕获。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { PromptInput } from '../../src/tui/input/PromptInput';

/** 把帧按行去掉前缀(`> ` 首行 / `  ` 续行)并拼接,还原成纯内容序列。 */
function reconstruct(frame: string): string {
  return frame
    .split('\n')
    .map((l) => l.replace(/^>[ \u00a0]/, '').replace(/^ {2}/, ''))
    .join('');
}

describe('PromptInput soft-wrap cursor placement', () => {
  test('长无空格行(硬折)+ 光标在末尾 → 可见字符按序还原 == 原文', () => {
    const value = 'X'.repeat(130); // >100 列必折行;无空格→硬折,顺序确定
    const { lastFrame } = render(<PromptInput value={value} cursor={value.length} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('\n'); // 确实折了行
    expect(reconstruct(frame)).toBe(value); // 无乱序/重复/padding
  });

  test('长行 + 光标在中间(可见 at 字符)→ 折行后字符序不乱', () => {
    const value = 'A'.repeat(60) + 'B'.repeat(60); // 120 长;col=60 处 at='B'
    const { lastFrame } = render(<PromptInput value={value} cursor={60} />);
    const frame = lastFrame() ?? '';
    expect(reconstruct(frame)).toBe(value);
  });

  test('首次收到整段 CJK 输入时提示符和正文保持在同一行', () => {
    // 复现真实 IME 首次提交：Ink 会在一次 input 事件里收到整段中文。提示符若和正文处于
    // 同一个可折行 Text，wrap-ansi 可能把 `> ` 当词边界，留下只有提示符的空首行。
    const value = '大师傅三大方法是打发打发发的撒的';
    const { lastFrame } = render(
      <Box width={50} borderStyle="round" paddingX={1}>
        <PromptInput value={value} cursor={value.length} />
      </Box>,
    );
    const firstContentRow = (lastFrame() ?? '').split('\n')[1] ?? '';
    expect(firstContentRow).toContain('> 大师傅');
  });

  test('显式换行多行:每行原样、前缀正确', () => {
    const value = 'hello\nworld';
    const { lastFrame } = render(<PromptInput value={value} cursor={value.length} />);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines[0]).toContain('hello');
    expect(lines[1]).toContain('world');
  });

  test('空 value → 渲染 placeholder 不抛', () => {
    const { lastFrame } = render(<PromptInput value="" cursor={0} placeholder="type here" />);
    expect(lastFrame() ?? '').toContain('type here');
  });
});
