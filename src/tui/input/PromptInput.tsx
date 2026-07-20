/**
 * PromptInput —— 受控纯渲染多行输入框。
 *
 * value / cursor 由上层持有，本组件只负责展示。每个逻辑行使用一个固定宽度的提示符列和
 * 一个完整的文本流；光标仍以内联 Text 渲染。提示符不能和正文放进同一个可折行 Text：
 * Ink 首次接收一整段 IME/CJK 输入时可能在两者之间断行，产生只有 `>` 的空首行。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { lineColOf } from './promptReducer';

export interface PromptInputProps {
  /** 全文（可含 \n）。 */
  value: string;
  /** 光标码点偏移（0..len）；越界由渲染夹紧。 */
  cursor: number;
  /** value 为空时的灰字占位提示。 */
  placeholder?: string;
}

/** 受控纯渲染：不持状态、不调用 useInput。 */
export function PromptInput(props: PromptInputProps): React.ReactElement {
  const theme = useTheme();
  return <Box flexDirection="column">{renderValue(props.value, props.cursor, theme, props.placeholder)}</Box>;
}

/** 固定的两列提示符，正文独占剩余宽度，避免提示符被软折行单独留在首行。 */
function PromptLine(props: {
  first: boolean;
  children: React.ReactNode;
  textColor: string;
  accentColor: string;
}): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color={props.accentColor}>{props.first ? '> ' : '  '}</Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={props.textColor}>{props.children}</Text>
      </Box>
    </Box>
  );
}

/** 渲染多行 value，并在光标处叠一个反显光标块。 */
function renderValue(
  value: string,
  cursor: number,
  theme: ReturnType<typeof useTheme>,
  placeholder?: string,
): React.ReactElement | React.ReactElement[] {
  if (value === '') {
    return (
      <PromptLine first textColor={theme.text} accentColor={theme.accent}>
        <Text color={theme.accent} inverse>
          {' '}
        </Text>
        {placeholder ? <Text color={theme.dim}>{placeholder}</Text> : null}
      </PromptLine>
    );
  }

  const lines = value.split('\n');
  const { line: curLine, col: curCol } = lineColOf(value, cursor);

  return lines.map((line, i) => {
    const isCursorLine = i === curLine;
    if (!isCursorLine) {
      return (
        <PromptLine key={i} first={i === 0} textColor={theme.text} accentColor={theme.accent}>
          {line.length ? line : ' '}
        </PromptLine>
      );
    }

    const arr = Array.from(line);
    const before = arr.slice(0, curCol).join('');
    const at = arr[curCol] ?? ' ';
    const after = arr.slice(curCol + 1).join('');
    return (
      <PromptLine key={i} first={i === 0} textColor={theme.text} accentColor={theme.accent}>
        {before}
        <Text color={theme.accent} inverse>
          {at}
        </Text>
        {after}
      </PromptLine>
    );
  });
}
