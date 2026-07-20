/**
 * LiveThinking —— 在飞(busy)阶段流式呈现 assistant 的 thinking 增量(F2)。
 *
 * cc 语义:thinking 先**流式显示出来**,轮末**折叠**。forgeax 转录区(Transcript 的 ThinkingView)
 * 已负责「轮末折叠(ctrl+o 展开)」那一半;本视图补上缺失的「在飞流式显示」那一半——只活在
 * turn 进行中,assistant 落定即由 Repl 清空、交棒给转录区折叠态(避免重复呈现)。
 *
 * 为免 Ink 动态区随 thinking 无限增长而超出终端高度、引发滚动弹跳,只显示末尾 MAX_LINES 行
 * (前面截断以 `…` 标记)——同 safeFlushBoundary 把 live 区压在一屏内的思路。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner';
import { useTheme } from '../providers/theme';

/** live thinking 动态区最多显示的尾部行数(超出前部截断)。 */
const MAX_LINES = 12;

export function LiveThinking(props: { text: string }): React.ReactElement | null {
  const theme = useTheme();
  const text = props.text.replace(/\s+$/, '');
  if (!text) return null;
  const lines = text.split('\n');
  const clipped = lines.length > MAX_LINES;
  const shown = clipped ? lines.slice(-MAX_LINES) : lines;
  return (
    <Box flexDirection="column">
      <Box>
        <Spinner />
        <Text color={theme.dim}>{' ✻ thinking…(ctrl+o 轮末展开)'}</Text>
      </Box>
      {clipped ? <Text color={theme.dim}>{'  …'}</Text> : null}
      {shown.map((l, i) => (
        <Text key={i} color={theme.dim}>{'  ' + l}</Text>
      ))}
    </Box>
  );
}
