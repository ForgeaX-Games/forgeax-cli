import React from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { theme } from "../lib/theme.js";
import { THINKING_SYMBOL } from "../lib/figures.js";

interface ThinkingStripProps {
  thinkingText: string;
}

export function ThinkingStrip({ thinkingText }: ThinkingStripProps): React.JSX.Element | null {
  if (!thinkingText) return null;

  const lastLine = extractLastLine(thinkingText);
  if (!lastLine) return null;

  return (
    <Box height={1} width="100%" flexShrink={0}>
      <Box flexShrink={1} flexGrow={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.thinking.symbolColor}>{THINKING_SYMBOL} </Text>
          <Text color={theme.thinking.textColor} italic>{lastLine}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function extractLastLine(text: string): string {
  let end = text.length;
  while (end > 0) {
    let start = text.lastIndexOf("\n", end - 1);
    if (start < 0) start = 0; else start += 1;
    const line = text.substring(start, end).trim();
    if (line) return line;
    end = start > 0 ? start - 1 : 0;
  }
  return "";
}
