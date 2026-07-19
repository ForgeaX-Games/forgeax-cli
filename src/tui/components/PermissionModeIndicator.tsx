/**
 * PermissionModeIndicator —— 输入框下方的权限模式指示条。
 *
 * default 完全不渲染(零噪音);其余模式渲染「符号 + 文案 + shift+tab 提示」。
 * 符号一律 ASCII —— TUI 串禁用 ambiguous-width 字符(Terminal.app 按宽 2、ink 按宽 1,
 * 混用会残影,见 tui 残影根因记录),故不用那套 ⏵⏵/⏸ 宽字符符号。
 * 颜色复用既有 ThemeTokens(accent/warning/dim),不为单组件扩张主题契约。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionMode } from '../../permission/engine';
import type { ThemeTokens } from '../contracts';

/** 纯 spec:mode → 渲染元数据(null = 不渲染)。tone → theme 色由组件收口;
 *  导出供单测断言(ink-testing-library 的 lastFrame 剥 ANSI,颜色只能测 tone 角色)。 */
export function permissionModeIndicatorSpec(
  mode: PermissionMode,
): { symbol: string; label: string; tone: 'accent' | 'warning' } | null {
  switch (mode) {
    case 'default':
      return null;
    case 'acceptEdits':
      return { symbol: '>>', label: 'accept edits on', tone: 'accent' };
    case 'plan':
      return { symbol: '||', label: 'plan mode on', tone: 'accent' };
    case 'bypassPermissions':
      return { symbol: '!!', label: 'bypass permissions on', tone: 'warning' };
  }
}

export function PermissionModeIndicator(props: {
  mode: PermissionMode;
  theme: ThemeTokens;
}): React.ReactElement | null {
  const spec = permissionModeIndicatorSpec(props.mode);
  if (!spec) return null;
  const color = spec.tone === 'warning' ? props.theme.warning : props.theme.accent;
  return (
    <Box paddingX={1}>
      <Text color={color}>{`${spec.symbol} ${spec.label}`}</Text>
      <Text color={props.theme.dim}>{'  (shift+tab 切换)'}</Text>
    </Box>
  );
}
