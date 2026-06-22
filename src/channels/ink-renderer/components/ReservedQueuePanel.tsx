/**
 * ReservedQueuePanel — visible buffer of inputs the user enqueued while the
 * agent was busy. Sits between StatusLayer and InputBox.
 *
 * Per-row affordances (mouse-clickable; mode-1003 mouse tracking is enabled
 * by AlternateScreen). Each queue entry owns its own pair of buttons:
 *   [send]  — pop & dispatch as steer (interrupts the running agent)
 *   [del]   — drop without sending
 *
 * Auto-flush (one item per turn end) drains the queue without UI interaction.
 * The bracketed buttons are kept visible at all times so the user can
 * preempt or prune even mid-stream.
 *
 * Visual contract:
 *   ⏳ 3 queued
 *   ▸ [send] [del] hello world
 *     [send] [del] fix the bug [Pasted #1]
 *     [send] [del] refactor stuff
 */

import React from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { theme } from "../lib/theme.js";
import type { ReservedItem } from "../hooks/use-reserved-queue.js";

interface ReservedQueuePanelProps {
  items: ReservedItem[];
  onFlush: (id: string) => void;
  onRemove: (id: string) => void;
}

const ITEM_TRUNCATE = 100;

function summarize(visualDisplay: string): string {
  const oneLine = visualDisplay.replace(/\s*\n\s*/g, " ⏎ ").trim();
  if (oneLine.length <= ITEM_TRUNCATE) return oneLine;
  return oneLine.slice(0, ITEM_TRUNCATE - 1) + "…";
}

export function ReservedQueuePanel({
  items,
  onFlush,
  onRemove,
}: ReservedQueuePanelProps): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" flexShrink={0} width="100%" paddingX={1}>
      <Box width="100%">
        <Text color={theme.spinner.color}>⏳ </Text>
        <Text bold color={theme.spinner.color}>{items.length} queued</Text>
      </Box>
      {items.map((item, idx) => (
        <ReservedRow
          key={item.id}
          item={item}
          isHead={idx === 0}
          onFlush={onFlush}
          onRemove={onRemove}
        />
      ))}
    </Box>
  );
}

interface ReservedRowProps {
  item: ReservedItem;
  isHead: boolean;
  onFlush: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * Render one queued message with two bracketed clickable buttons. We use
 * `[send]` / `[del]` over glyph-only icons because terminal users immediately
 * recognise bracketed labels as actions, whereas symbols like ▶/✕ are
 * ambiguous (could be a status marker, a bullet, etc.).
 */
function ReservedRow({ item, isHead, onFlush, onRemove }: ReservedRowProps): React.JSX.Element {
  const summary = summarize(item.visualDisplay || item.text);
  return (
    <Box width="100%">
      <Box flexShrink={0} marginRight={1}>
        <Text color={isHead ? theme.spinner.color : undefined} dimColor={!isHead}>{isHead ? "▸" : " "}</Text>
      </Box>
      <Box flexShrink={0} marginRight={1} onClick={() => onFlush(item.id)}>
        <Text color={theme.userInput.color} bold>[send]</Text>
      </Box>
      <Box flexShrink={0} marginRight={1} onClick={() => onRemove(item.id)}>
        <Text color={theme.error.color} bold>[del]</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1} overflow="hidden">
        <Text wrap="truncate" dimColor={!isHead}>{summary}</Text>
      </Box>
    </Box>
  );
}
