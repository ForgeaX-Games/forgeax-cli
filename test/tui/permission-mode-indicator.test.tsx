/**
 * PermissionModeIndicator —— 权限模式指示条测试。
 *
 * 两层:① 纯 spec(mode → symbol/label/tone;ink-testing-library 的 lastFrame 剥 ANSI,
 * 颜色只能测 tone 角色);② 真渲染(default 空输出、非 default 三态文案 + shift+tab 提示)。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  PermissionModeIndicator,
  permissionModeIndicatorSpec,
} from '../../src/tui/components/PermissionModeIndicator';
import { darkTheme } from '../../src/tui/theme/tokens';

describe('permissionModeIndicatorSpec — 纯 spec', () => {
  test('default → null(不渲染)', () => {
    expect(permissionModeIndicatorSpec('default')).toBeNull();
  });

  test('acceptEdits / plan → accent tone;bypassPermissions → warning tone', () => {
    expect(permissionModeIndicatorSpec('acceptEdits')).toEqual({
      symbol: '>>',
      label: 'accept edits on',
      tone: 'accent',
    });
    expect(permissionModeIndicatorSpec('plan')).toEqual({
      symbol: '||',
      label: 'plan mode on',
      tone: 'accent',
    });
    expect(permissionModeIndicatorSpec('bypassPermissions')).toEqual({
      symbol: '!!',
      label: 'bypass permissions on',
      tone: 'warning',
    });
  });

  test('符号全 ASCII(TUI 禁 ambiguous-width 字符,防终端残影)', () => {
    for (const mode of ['acceptEdits', 'plan', 'bypassPermissions'] as const) {
      const spec = permissionModeIndicatorSpec(mode)!;
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]+$/.test(`${spec.symbol} ${spec.label}`)).toBe(true);
    }
  });
});

describe('PermissionModeIndicator — 真渲染', () => {
  test('default 完全不渲染(零噪音)', () => {
    const { lastFrame } = render(<PermissionModeIndicator mode="default" theme={darkTheme} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  test.each([
    ['acceptEdits', '>> accept edits on'],
    ['plan', '|| plan mode on'],
    ['bypassPermissions', '!! bypass permissions on'],
  ] as const)('%s 渲染文案 + shift+tab 提示', (mode, text) => {
    const { lastFrame } = render(<PermissionModeIndicator mode={mode} theme={darkTheme} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(text);
    expect(frame).toContain('shift+tab');
  });
});
