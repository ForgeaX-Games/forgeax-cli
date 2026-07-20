/**
 * 验收补测(06-消息视图与富文本):Markdown 块级/行内富文本渲染的执行级证据。
 * 覆盖 06.6-06.17（heading/list/bold/italic/inline-code/link/code-fence/table），
 * 用 ink-testing-library 真渲染断言可见文本。样式(bold/color)在 test frame 不可见,
 * 故断言「标记被消费(不残留 星号/下划线/反引号)+ 正文可见」。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Markdown } from '../../src/tui/components/Markdown';

const frameOf = (src: string): string => render(<Markdown>{src}</Markdown>).lastFrame() ?? '';
const BT = String.fromCharCode(96); // backtick char, built from code to avoid literal in source
const FENCE = BT + BT + BT;

describe('06 Markdown 富文本渲染', () => {
  test('06.6 纯文本透传,不被误解析', () => {
    const f = frameOf('just plain text.');
    expect(f).toContain('just plain text.');
  });

  test('06.7 标题:# / ### 保留层级 # 数量', () => {
    const f = frameOf('# Title\n\n### Sub');
    expect(f).toContain('# Title');
    expect(f).toContain('### Sub'); // 层级 # 数量保留
  });

  test('06.8 无序列表:- / * 混用 → bullet 项', () => {
    const f = frameOf('- a\n- b\n* c');
    expect(f).toContain('- a');
    expect(f).toContain('- b');
    expect(f).toContain('- c'); // * c 也归一为 bullet
  });

  test('06.9 有序列表:递增序号', () => {
    const f = frameOf('1. x\n2. y');
    expect(f).toContain('1. x');
    expect(f).toContain('2. y');
  });

  test('06.10 行内加粗/斜体:标记被消费,正文保留', () => {
    const f = frameOf('**B** and *i* and __b2__');
    expect(f).toContain('B');
    expect(f).toContain('i');
    expect(f).toContain('b2');
    expect(f).not.toContain('**'); // ** 优先于 * 不被吞、且被消费
    expect(f).not.toContain('__');
  });

  test('06.11 行内 code:内容可见、反引号被消费', () => {
    const f = frameOf('use ' + BT + 'npm i' + BT + ' now');
    expect(f).toContain('npm i');
    expect(f).toContain('use');
    expect(f).toContain('now');
    expect(f).not.toContain(BT);
  });

  test('06.12 链接:text + 可见 dim url 追加(forgeax 有意 ≠ cc 的 OSC8)', () => {
    const f = frameOf('[docs](https://x.io)');
    expect(f).toContain('docs');
    expect(f).toContain('https://x.io'); // url 作可见文本追加
  });

  test('06.13 围栏代码块(带 lang)高亮不丢内容', () => {
    const f = frameOf(FENCE + 'ts\nconst a=1;\n' + FENCE);
    expect(f).toContain('const');
    expect(f).toContain('a');
  });

  test('06.14 无语言代码块:探测/降级,内容保留不抛', () => {
    const f = frameOf(FENCE + '\nraw text here\n' + FENCE);
    expect(f).toContain('raw text here');
  });

  test('06.15 非法代码不崩(ignoreIllegals),渲染原文', () => {
    let f = '';
    expect(() => { f = frameOf(FENCE + 'js\n{{{ not valid\n' + FENCE); }).not.toThrow();
    expect(f).toContain('{{{');
  });

  test('06.16 表格:识别并渲染各列内容', () => {
    const f = frameOf('|a|b|\n|---|---|\n|1|2|');
    expect(f).toContain('a');
    expect(f).toContain('b');
    expect(f).toContain('1');
    expect(f).toContain('2');
  });

  test('06.17 伪表格(下一行非分隔行)→ 落 para,管道原样', () => {
    const f = frameOf('|a|b|\nplain next line');
    expect(f).toContain('|a|b|'); // 未识别为表格,原样保留竖线
    expect(f).toContain('plain next line');
  });

  test('06.29 长 CJK 段落渲染全内容不抛', () => {
    const long = '这是一段很长的中文段落用于验证软折行'.repeat(6);
    let f = '';
    expect(() => { f = frameOf(long); }).not.toThrow();
    expect(f.replace(/\s/g, '')).toContain('这是一段很长的中文段落用于验证软折行');
  });
});
