/**
 * ToolResultRow — shared tool result presentation used by both
 * MessageRow and SubagentActivity.
 */

import React, { useContext } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { Ansi } from "../ink/Ansi.js";
import { RawAnsi } from "../ink/components/RawAnsi.js";
import { applyMarkdown } from "../utils/markdown.js";
import { theme } from "../lib/theme.js";
import { ColumnsContext } from "../lib/contexts.js";
import { Collapsible } from "./Collapsible.js";

const RAWANSI_LINE_THRESHOLD = 20;

const ANSI_ESC = /\x1b\[/;
const ANSI_RED = /\x1b\[31m/;
const ANSI_GREEN = /\x1b\[32m/;

export function ToolResultRow({ status, resultDisplay, fullResult }: {
  status: string;
  resultDisplay?: string;
  /** Full untruncated result for progressive expansion. */
  fullResult?: string;
}) {
  if (!resultDisplay) return null;

  const lines = resultDisplay.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  const isSingleLine = lines.length === 1;
  const expandContent = fullResult ?? resultDisplay;
  const totalLines = expandContent.split("\n").filter(l => l.trim()).length;
  const lineHint = totalLines > 1 ? `${totalLines}行，点击展开` : "点击展开";

  if (isSingleLine && !fullResult) {
    return (
      <Box width="100%">
        <Box flexShrink={0}><Text dimColor>  {theme.toolResult.connector} </Text></Box>
        <Box flexGrow={1} flexShrink={1}><DiffAwareLine>{lines[0]!}</DiffAwareLine></Box>
      </Box>
    );
  }

  return (
    <Collapsible
      collapsedSummary={
        <Box width="100%">
          <Box flexShrink={0}><Text dimColor>  {theme.toolResult.connector} </Text></Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate"><DiffAwareLine>{lines[0]!}</DiffAwareLine><Text dimColor>...({lineHint})</Text></Text>
          </Box>
        </Box>
      }
      summary={
        <Box width="100%">
          <Box flexShrink={0}><Text dimColor>  {theme.toolResult.connector} </Text></Box>
          <Box flexGrow={1} flexShrink={1}><DiffAwareLine>{lines[0]!}</DiffAwareLine></Box>
        </Box>
      }
    >
      <ResultBlock display={expandContent} skipFirstLine />
    </Collapsible>
  );
}

function ResultBlock({ display, skipFirstLine }: { display: string; skipFirstLine?: boolean }) {
  const allLines = display.split("\n");
  const lines = skipFirstLine ? allLines.slice(allLines.findIndex(l => l.trim()) + 1) : allLines;
  const columns = useContext(ColumnsContext);

  const hasDiff = lines.some(l => ANSI_RED.test(l) || ANSI_GREEN.test(l));

  if (!hasDiff && lines.length > RAWANSI_LINE_THRESHOLD) {
    return (
      <Box paddingLeft={6} flexDirection="column">
        <RawAnsi lines={lines} width={columns - 8} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line, i) => (
        <Box key={i} width="100%">
          <Box flexShrink={0}><Text dimColor>{"      "}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><DiffAwareLine>{line}</DiffAwareLine></Box>
        </Box>
      ))}
    </Box>
  );
}

function DiffAwareLine({ children: line }: { children: string }) {
  if (ANSI_ESC.test(line)) {
    if (ANSI_RED.test(line)) return <Text backgroundColor={theme.diff.remove.bg}><Ansi>{line}</Ansi></Text>;
    if (ANSI_GREEN.test(line)) return <Text backgroundColor={theme.diff.add.bg}><Ansi>{line}</Ansi></Text>;
    return <Ansi>{line}</Ansi>;
  }
  return <Ansi>{applyMarkdown(line, theme.markdown.theme)}</Ansi>;
}
