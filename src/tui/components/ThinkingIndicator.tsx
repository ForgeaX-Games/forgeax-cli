/** ThinkingIndicator(T8 转交)—— busy 时 spinner + thinking...。
 *
 *  T4.5 感知:后台任务在跑时本行常驻一个**静态计数标签**,shell 与子 agent 分列:
 *  「2 个后台 shell | 2 个后台任务 (35s)」。shell 常驻(dev server)**不计时**——避免把
 *  长跑服务误读成"有任务待完成"(与 CC 的 "N shells" chip 同语义);子 agent 是有限作业,
 *  跟一个耗时(从首个后台任务启动起,全部 settle 归零清空)。idle 不转 spinner;busy 时
 *  并进 thinking 行(单行不叠)。全部退出即整行消失。字符纪律:纯 ASCII + CJK,无
 *  ambiguous-width 字符。
 *  Boundary(HOST 层):react + ink + 相对 import。 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner';
import { useTheme } from '../providers/theme';

/** 分列计数标签:shell 段不带时间,子 agent 段带可选耗时;两段都有时用 ` | ` 连接。 */
export function bgTaskLabel(shells: number, agents: number, agentSecs?: number): string {
  const parts: string[] = [];
  if (shells > 0) parts.push(`${shells} 个后台 shell`);
  if (agents > 0) parts.push(`${agents} 个后台任务${agentSecs != null ? ` (${agentSecs}s)` : ''}`);
  return parts.join(' | ');
}

export function ThinkingIndicator(props: {
  busy?: boolean;
  bgShells?: number;
  bgAgents?: number;
}): React.ReactElement | null {
  const theme = useTheme();
  const shells = props.bgShells ?? 0;
  const agents = props.bgAgents ?? 0;
  // 子 agent 计时:agents 0→>0 记起点,归零清空;在跑期间每秒重渲推进秒数(shell 不参与)。
  const startRef = useRef<number | null>(null);
  if (agents > 0 && startRef.current == null) startRef.current = Date.now();
  if (agents === 0) startRef.current = null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (agents === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [agents]);

  const agentSecs = startRef.current != null ? Math.floor((Date.now() - startRef.current) / 1000) : undefined;
  const bgText = bgTaskLabel(shells, agents, agentSecs);
  if (!props.busy && bgText === '') return null;
  if (!props.busy) {
    return (
      <Box>
        <Text color={theme.dim}>{bgText}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Spinner />
      <Text color={theme.dim}> thinking...{bgText ? ` | ${bgText}` : ''}</Text>
    </Box>
  );
}
