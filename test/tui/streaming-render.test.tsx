/**
 * Transcript 的流式渲染集成测试(ink-testing-library):streamingText prop → live 尾部
 * 通过 renderItem → AssistantView → Markdown 渲染,与最终 assistant 条目同一路径。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Transcript } from '../../src/tui/transcript/Transcript';
// 触发消息视图自注册(user/assistant/notice);app.tsx 同款副作用 import,否则落 thin 兜底。
import '../../src/tui/views/messages/index';
import '../../src/tui/views/tools/index';

const toolMeta = (name: string) => ({ canonical: name, displayName: name });

describe('Transcript streamingText', () => {
  test('non-empty streamingText renders as live text', () => {
    const { lastFrame } = render(
      <Transcript log={[]} busy toolMeta={toolMeta} streamingText={'hello streaming world'} />,
    );
    expect(lastFrame()).toContain('hello streaming world');
  });

  test('empty streamingText renders nothing extra', () => {
    const { lastFrame } = render(<Transcript log={[]} busy toolMeta={toolMeta} streamingText={''} />);
    expect(lastFrame()?.trim()).toBe('');
  });

  test('streaming text coexists with committed log (no crash)', () => {
    const log = [{ kind: 'user' as const, text: 'hi there user' }];
    const { lastFrame } = render(
      <Transcript log={log} busy toolMeta={toolMeta} streamingText={'partial answer being written'} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('partial answer being written');
  });

  test('over-budget streamingText is tail-clipped with … marker (anti-ghosting)', () => {
    // 40 条短行远超预算(测试环境 rows 未知 → 24 − 预留 12 = 12 行):动态区若整段
    // 渲染会高过终端视口,Ink 擦不净溢出行 → scrollback 残影。断言只剩尾窗 + `…`。
    const lines = Array.from({ length: 40 }, (_, i) => `stream-line-${i}`);
    const { lastFrame } = render(
      <Transcript log={[]} busy toolMeta={toolMeta} streamingText={lines.join('\n')} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    expect(frame).toContain('stream-line-39'); // 末尾可见
    expect(frame).not.toContain('stream-line-0\n'); // 开头被裁
    expect(frame).not.toContain('stream-line-10'); // 窗口外(40−12=28 起才可见)
  });
});
