/**
 * Banner.tsx —— 欢迎横幅(logo / 产品名+版本 / 模型·会话 / cwd)。
 *
 * 经 Transcript 的 header prop 挂进 <Static> 发射**一次**,随 scrollback 自然上滚
 * (live 区每帧重画,放那里会闪且被压到底部)。/clear、resize、/resume 重挂载
 * <Static> 时白得重现。横幅是**渲染关切**不是会话数据 —— 不进 session 日志,
 * 不污染 /resume 历史重建与 toHistory 喂模型路径;也非 user 行,不发 OSC 133 标记。
 *
 * 终端宽 < 60 列隐藏 logo 只留文字;cwd 超宽时头部截断(`…` 前缀,对齐 cc/cbc)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { displayWidth, termWidth } from '../text-width';

/** 头部截断到 max 显示列(宽字符感知):超宽 → `…` 前缀 + 尾部保留。 */
export function truncateHead(s: string, max: number): string {
  if (max <= 1 || displayWidth(s) <= max) return displayWidth(s) <= max ? s : '…';
  const chars = Array.from(s);
  let w = 1; // '…' 本身占 1 列
  const kept: string[] = [];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = displayWidth(chars[i]!);
    if (w + cw > max) break;
    w += cw;
    kept.unshift(chars[i]!);
  }
  return `…${kept.join('')}`;
}

/** ~4 行块字 logo(accent 色);窄终端(<60 列)整块隐藏。 */
const LOGO = [' ██████╗', ' ██╔═══╝', ' ██║    ', ' ╚═════╝'] as const;
const LOGO_COLS = 10; // logo 列宽 + 右侧间距(cwd 截断预算用)
const MIN_COLS_FOR_LOGO = 60;

export interface BannerProps {
  version: string;
  model: string;
  sessionId?: string;
  cwd: string;
}

export function Banner(props: BannerProps): React.ReactElement {
  const theme = useTheme();
  const cols = termWidth();
  const showLogo = cols >= MIN_COLS_FOR_LOGO;
  const textBudget = Math.max(20, cols - (showLogo ? LOGO_COLS + 2 : 2));
  return (
    <Box flexDirection="row">
      {showLogo ? (
        <Box flexDirection="column" marginRight={2}>
          {LOGO.map((line, i) => (
            <Text key={i} color={theme.accent}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" justifyContent="center">
        <Text bold>
          forgeax-cli <Text color={theme.accent}>v{props.version}</Text>
        </Text>
        <Text color={theme.dim}>
          {props.model}
          {props.sessionId ? ` · session ${props.sessionId}` : ''}
        </Text>
        <Text color={theme.dim}>{truncateHead(props.cwd, textBudget)}</Text>
      </Box>
    </Box>
  );
}
