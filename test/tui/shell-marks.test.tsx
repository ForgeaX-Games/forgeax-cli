/**
 * shell-marks 单测 —— 终端 shell-integration 标记(OSC 133)。
 *
 * 覆盖(对齐评审必改项):
 *  - UserView(shellMarks=true):D;0 → A → `› ` → B → 正文 → C 的顺序;各恰好一次;
 *    C 在末行可见文本后、padding 前;多行输入 A/B 只在首行、C 只在末行。
 *  - 宽度中性:剥掉 OSC 133 序列后与不加标记的渲染字节级相等(标记不进 padToWidth)。
 *  - UserView(无 shellMarks)/ live 区(Transcript 未配对 tool_call 钉住边界):零标记。
 *  - Transcript 提交区:enablement 走 shellMarksEnabled()(测试环境非 TTY → 关;stub
 *    isTTY 后 → committed 条目带标记,live 条目不带)。
 *  - shellMarksEnabled():isTTY 与 FORGEAX_NO_SHELL_MARKS=1 两道闸。
 *  - cleanRedraw():D;0 先于 2J(利用 VS Code 的 2J 拦截清记账);非 TTY 不发。
 *
 * 仅 `bun test test/tui/shell-marks.test.tsx`。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { defaultTheme } from '../../src/tui/theme/tokens';
import { UserView } from '../../src/tui/views/messages/User';
import {
  PROMPT_START,
  COMMAND_START,
  OUTPUT_START,
  COMMAND_CLOSE,
  shellMarksEnabled,
} from '../../src/tui/shell-marks';
import { cleanRedraw } from '../../src/tui/use-resize-redraw';
import { Transcript } from '../../src/tui/transcript/Transcript';
import type { SessionEntry } from '../../src/tui/transcript/items';
// 触发消息/工具视图自注册(app.tsx 同款副作用 import,否则落 thin 兜底)。
import '../../src/tui/views/messages/index';
import '../../src/tui/views/tools/index';

const THEME = defaultTheme;
const OSC133_RE = /\x1b\]133;[^\x07]*\x07/g;
const count = (s: string, needle: string): number => s.split(needle).length - 1;

function renderUser(text: string, shellMarks?: boolean): string {
  const props = { item: { kind: 'user' as const, id: 0, text }, theme: THEME, shellMarks };
  const El = (): React.ReactElement => UserView(props) as React.ReactElement;
  const { lastFrame } = render(React.createElement(El));
  return lastFrame() ?? '';
}

// ── isTTY stub(shellMarksEnabled 读真 process.stdout;测试环境通常非 TTY)──────
const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
function stubTTY(v: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
}
function restoreTTY(): void {
  if (ttyDesc) Object.defineProperty(process.stdout, 'isTTY', ttyDesc);
  else delete (process.stdout as unknown as Record<string, unknown>).isTTY;
}

afterEach(() => {
  restoreTTY();
  delete process.env.FORGEAX_NO_SHELL_MARKS;
});

describe('UserView shell marks', () => {
  test('单行:D;0 → A → › → B → 正文 → C 顺序,各恰好一次', () => {
    const frame = renderUser('如何拿构建记录', true);
    expect(count(frame, '\x1b]133;D;0\x07')).toBe(1);
    expect(count(frame, '\x1b]133;A\x07')).toBe(1);
    expect(count(frame, '\x1b]133;B\x07')).toBe(1);
    expect(count(frame, '\x1b]133;C\x07')).toBe(1);
    const iD = frame.indexOf('\x1b]133;D;0\x07');
    const iA = frame.indexOf('\x1b]133;A\x07');
    const iArrow = frame.indexOf('› ');
    const iB = frame.indexOf('\x1b]133;B\x07');
    const iText = frame.indexOf('如何拿构建记录');
    const iC = frame.indexOf('\x1b]133;C\x07');
    expect(iD).toBeGreaterThanOrEqual(0);
    expect(iA).toBeGreaterThan(iD);
    expect(iArrow).toBeGreaterThan(iA); // `› ` 在 A..B 之间(prompt 前缀)
    expect(iB).toBeGreaterThan(iArrow);
    expect(iText).toBeGreaterThan(iB);
    expect(iC).toBeGreaterThan(iText);
  });

  test('C 在可见文本之后、补底色 padding 之前(不吞尾随空格进 command)', () => {
    const frame = renderUser('hello', true);
    // C 紧跟正文末字符:B 与 C 之间应恰为正文,无 padding 空格。
    const between = frame.slice(
      frame.indexOf('\x1b]133;B\x07') + '\x1b]133;B\x07'.length,
      frame.indexOf('\x1b]133;C\x07'),
    );
    expect(between).toBe('hello');
  });

  test('多行:A/B 仅首行,C 仅末行,续行无标记', () => {
    const frame = renderUser('第一行\n第二行\n第三行', true);
    expect(count(frame, '\x1b]133;A\x07')).toBe(1);
    expect(count(frame, '\x1b]133;B\x07')).toBe(1);
    expect(count(frame, '\x1b]133;C\x07')).toBe(1);
    const lines = frame.split('\n');
    expect(lines[0]).toContain('\x1b]133;B\x07');
    expect(lines[lines.length - 1]).toContain('\x1b]133;C\x07');
    // C 在末行正文后。
    const last = lines[lines.length - 1]!;
    expect(last.indexOf('第三行')).toBeLessThan(last.indexOf('\x1b]133;C\x07'));
  });

  test('宽度中性:剥掉标记后与不加标记的渲染字节级相等', () => {
    for (const text of ['hello world', '中文宽字符输入测试', 'mixed 中英 mix\n第二行 line2']) {
      const marked = renderUser(text, true).replace(OSC133_RE, '');
      const plain = renderUser(text, false);
      expect(marked).toBe(plain);
    }
  });

  test('shellMarks 未传 / false → 零标记', () => {
    expect(renderUser('hello')).not.toContain('\x1b]133;');
    expect(renderUser('hello', false)).not.toContain('\x1b]133;');
  });
});

describe('Transcript 提交区 vs live 区', () => {
  const toolMeta = (name: string) => ({ canonical: name, displayName: name });

  test('committed(stub TTY):user 条目带标记;live(未配对 tool_call 之后)不带', async () => {
    stubTTY(true);
    // log:user#0(可提交)→ tool_call(未配对,钉住边界)→ user#1(滞留 live 区)。
    const log: SessionEntry[] = [
      { kind: 'user', text: 'first committed prompt' },
      {
        kind: 'event',
        event: {
          type: 'tool_call',
          toolUseId: 't1',
          toolName: 'bash',
          input: { command: 'sleep 999' },
        } as never,
      },
      { kind: 'user', text: 'second queued prompt' },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(Transcript, { log, busy: true, toolMeta }),
    );
    await new Promise((r) => setTimeout(r, 30)); // 等 flushed effect + Static emit 落定
    // ⚠️ ink-testing-library 走 debug 模式:每帧重写 fullStaticOutput+output(生产 TTY 路径
    //   Static 只写一次,由本仓 ink patch 保证)——故在**单帧**内断言,不跨帧计数。
    const frame = lastFrame() ?? '';
    unmount(); // 停 spinner,防测试进程挂住
    // committed 的 user#0 带标记(单帧内恰好一组)。
    expect(count(frame, '\x1b]133;A\x07')).toBe(1);
    expect(count(frame, '\x1b]133;B\x07')).toBe(1);
    expect(count(frame, '\x1b]133;C\x07')).toBe(1);
    expect(frame).toContain('first committed prompt');
    // live 区的 user#1 无标记:其所在行不含任何 OSC 133。
    const liveLine = frame.split('\n').find((l) => l.includes('second queued prompt')) ?? '';
    expect(liveLine).not.toBe('');
    expect(liveLine).not.toContain('\x1b]133;');
    // 标记只挂在 committed 的 user#0 行上。
    const markedLine = frame.split('\n').find((l) => l.includes('\x1b]133;A\x07')) ?? '';
    expect(markedLine).toContain('first committed prompt');
  });

  test('resume 全量回放不重发标记，回放后新提交仍发标记', async () => {
    stubTTY(true);
    const initial: SessionEntry[] = [{ kind: 'user', text: 'old current prompt' }];
    const restored: SessionEntry[] = [
      { kind: 'user', text: 'restored prompt one' },
      { kind: 'user', text: 'restored prompt two' },
    ];
    const view = render(
      React.createElement(Transcript, {
        log: initial,
        busy: false,
        toolMeta,
        redrawNonce: 0,
      }),
    );

    // /resume:nonce 变化表示 transcript 身份整体替换。旧 prompt 要显示，但不能让 VS Code
    // 把历史回放重新登记成 command（否则会生成顶部空白 sticky-command 横条）。
    view.rerender(
      React.createElement(Transcript, {
        log: restored,
        busy: false,
        toolMeta,
        redrawNonce: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const replayFrame = view.lastFrame() ?? '';
    const restoredLines = replayFrame
      .split('\n')
      .filter((line) => line.includes('restored prompt'));

    // cutoff 之后的新 user 不是回放，仍保留正常 shell integration。
    view.rerender(
      React.createElement(Transcript, {
        log: [...restored, { kind: 'user', text: 'fresh prompt after resume' }],
        busy: false,
        toolMeta,
        redrawNonce: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const freshFrame = view.lastFrame() ?? '';
    view.unmount();

    // testing-library 不会像 Repl.replaceTranscript 那样 resetStaticOutput，旧 initial Static
    // 仍可能留在整帧；只检查本次恢复出来的行，避免把那条旧 marker 误算成 replay marker。
    expect(restoredLines).toHaveLength(2);
    expect(restoredLines.join('\n')).not.toContain('\x1b]133;');
    const freshLine = freshFrame.split('\n').find((l) => l.includes('fresh prompt after resume')) ?? '';
    expect(freshLine).toContain('\x1b]133;A\x07');
    expect(freshLine).toContain('\x1b]133;B\x07');
    expect(freshLine).toContain('\x1b]133;C\x07');
  });

  test('非 TTY(默认测试环境):committed 也不发标记', async () => {
    stubTTY(false);
    const log: SessionEntry[] = [{ kind: 'user', text: 'plain prompt' }];
    const { frames, unmount } = render(React.createElement(Transcript, { log, busy: false, toolMeta }));
    await new Promise((r) => setTimeout(r, 30));
    unmount();
    expect(frames.join('\n')).not.toContain('\x1b]133;');
  });
});

describe('shellMarksEnabled 两道闸', () => {
  test('isTTY=false → false;isTTY=true → true;env 关闭 → false', () => {
    stubTTY(false);
    expect(shellMarksEnabled()).toBe(false);
    stubTTY(true);
    expect(shellMarksEnabled()).toBe(true);
    process.env.FORGEAX_NO_SHELL_MARKS = '1';
    expect(shellMarksEnabled()).toBe(false);
  });
});

describe('cleanRedraw 收口顺序', () => {
  test('TTY 下:D;0 先于 2J;非 TTY 不发 D', () => {
    const orig = process.stdout.write.bind(process.stdout);
    let captured = '';
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      captured += c;
      return true;
    };
    try {
      stubTTY(true);
      cleanRedraw();
      const iD = captured.indexOf(COMMAND_CLOSE);
      const i2J = captured.indexOf('\x1b[2J');
      expect(iD).toBeGreaterThanOrEqual(0);
      expect(i2J).toBeGreaterThan(iD);

      captured = '';
      stubTTY(false);
      cleanRedraw();
      expect(captured).not.toContain('\x1b]133;');
      expect(captured).toContain('\x1b[2J');
      // resize 只能清当前视口;CSI 3J 会销毁完整 scrollback,导致历史再也滚不到开头。
      expect(captured).not.toContain('\x1b[3J');

      captured = '';
      cleanRedraw({ clearScrollback: true });
      // /resume、rewind、/clear 是 transcript 整体替换，须删除不再属于新会话的旧 scrollback。
      expect(captured).toContain('\x1b[2J');
      expect(captured).toContain('\x1b[3J');
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
  });
});

describe('标记常量形状', () => {
  test('D 必须带 exit code(bare D 会被 VS Code cmd+↑/↓ skipEmptyCommands 跳过)', () => {
    expect(PROMPT_START).toContain(']133;D;0\x07');
    expect(COMMAND_CLOSE).toBe('\x1b]133;D;0\x07');
    expect(COMMAND_START).toBe('\x1b]133;B\x07');
    expect(OUTPUT_START).toBe('\x1b]133;C\x07');
  });
});
