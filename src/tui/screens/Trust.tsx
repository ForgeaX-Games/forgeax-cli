/**
 * Trust.tsx —— 首启信任弹窗(独立前置 Ink render,主 REPL 之前)。
 *
 * 为什么独立 render 而不进 App 的 Provider 树:App 依赖 driver、driver 依赖
 * host context,而 host context(hooks/MCP/plugins 装配)恰是信任门要拦的东西 ——
 * 门必须在 buildHostContext 之前。cc 的 onboarding 同样是主 REPL 之前的独立渲染阶段。
 *
 * 自带局部 useInput:此时 Repl 的「唯一 useInput」尚未挂载,两个 render 生命周期
 * 不重叠,不违反单输入 owner 铁律。文案/选项 SSOT 在 ../../cli/trust。
 *
 * 交互:↑↓ 移动、数字键直选、Enter 确认、Esc / Ctrl-C = 退出(对齐 cc onCancel → exit)。
 *
 * Boundary(HOST 层):react + ink + 相对 import(含跨 host 的 ../../cli/trust)。
 */
import React, { useState } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { useTheme } from '../providers/theme';
import {
  TRUST_TITLE,
  TRUST_BODY,
  TRUST_HOME_WARNING,
  TRUST_OPTIONS,
  isHomeDir,
} from '../../cli/trust';

export function TrustDialog(props: {
  cwd: string;
  onDecision: (trusted: boolean) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return props.onDecision(false);
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) return setIndex((i) => Math.min(TRUST_OPTIONS.length - 1, i + 1));
    if (key.return) return props.onDecision(TRUST_OPTIONS[index]!.value === 'trust');
    const n = Number(input);
    if (n >= 1 && n <= TRUST_OPTIONS.length) {
      return props.onDecision(TRUST_OPTIONS[n - 1]!.value === 'trust');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.success}>
        {TRUST_TITLE}
      </Text>
      <Box marginTop={1}>
        <Text bold>{props.cwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{TRUST_BODY}</Text>
      </Box>
      {isHomeDir(props.cwd) ? (
        <Box marginTop={1}>
          <Text color={theme.dim}>{TRUST_HOME_WARNING}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {TRUST_OPTIONS.map((o, i) => (
          <Text key={o.value} color={i === index ? theme.accent : theme.text}>
            {i === index ? '❯ ' : '  '}
            {i + 1}. {o.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>Enter 确认 · Esc 退出</Text>
      </Box>
    </Box>
  );
}

/** 独立小 render:等用户决策 → unmount 还屏 → 返回选择(true=信任)。
 *  抛出的异常由调用方(trustGate)接住并降级纯文本门,绝不静默放行。
 *  ⚠️ 不 await waitUntilExit:Bun + Ink 下 unmount() 后它可能不 resolve(实测),
 *  而 unmount 本身已同步还屏;决策已拿到,直接返回。 */
export async function runTrustDialog(cwd: string): Promise<boolean> {
  let decide: (v: boolean) => void = () => {};
  const decision = new Promise<boolean>((r) => (decide = r));
  const instance = render(<TrustDialog cwd={cwd} onDecision={(t) => decide(t)} />);
  const ok = await decision;
  instance.unmount();
  return ok;
}
