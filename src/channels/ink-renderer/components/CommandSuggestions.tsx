/**
 * CommandSuggestions — renders a slash-command suggestion list above the input.
 * Uses a centered-window algorithm to show at most MAX_VISIBLE items.
 *
 * Layout invariant: the command name MUST render in full — even when long
 * (e.g. `/skill-creator`). The description gets the remaining columns and
 * truncates with an ellipsis when space is tight.
 *
 *   ┌ marker + name (flexShrink=0, natural width via padEnd) ┐ description (flexGrow=1, truncate-end) ┐
 *   │ ▶ /skill-creator                                       │ — [skill] Guide for creating effecti… │
 *   └────────────────────────────────────────────────────────┴───────────────────────────────────────┘
 *
 * Why padEnd instead of Box width/minWidth: under width="100%" with multiple
 * sibling Boxes, Ink/Yoga's space allocation can clip a flexShrink=0 child to
 * less than its intrinsic width (observed: `/skill-creator` truncated to
 * `/skill-creato`). Padding the name string itself to NAME_COL guarantees the
 * separator aligns for short names without relying on flex sizing edge cases.
 */

import React from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import type { SlashCommand } from "../types.js";
import { theme } from "../lib/theme.js";

const MAX_VISIBLE = 5;
// Target column for the `—` separator on rows with short names. Long names
// (e.g. `/skill-creator`, `/delete-instance`) exceed this and push the
// separator further right — that's intentional: name comes first.
const NAME_COL = 18;

interface CommandSuggestionsProps {
  suggestions: SlashCommand[];
  selectedIdx: number;
}

export function CommandSuggestions({
  suggestions,
  selectedIdx,
}: CommandSuggestionsProps): React.JSX.Element {
  const startIndex = Math.max(0, Math.min(
    selectedIdx - Math.floor(MAX_VISIBLE / 2),
    suggestions.length - MAX_VISIBLE,
  ));
  const endIndex = Math.min(startIndex + MAX_VISIBLE, suggestions.length);
  const visible = suggestions.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column" width="100%" borderStyle={theme.overlay.borderStyle} borderColor={theme.overlay.borderColor}>
      {visible.map((cmd, i) => {
        const realIdx = startIndex + i;
        const selected = realIdx === selectedIdx;
        // Pad short names to NAME_COL so the `—` separator aligns; long names
        // (>= NAME_COL chars) render at natural width and push the separator.
        const namePadded = `/${cmd.name}`.padEnd(NAME_COL);
        return (
          <Box key={cmd.name} width="100%" flexWrap="nowrap">
            <Box flexShrink={0}>
              <Text color={selected ? theme.overlay.selectedColor : undefined} bold={selected}>
                {selected ? `${theme.overlay.selectedChar} ` : "  "}
              </Text>
              <Text color={selected ? theme.overlay.selectedColor : theme.overlay.commandColor} bold={selected}>
                {namePadded}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">— {cmd.description}</Text>
            </Box>
          </Box>
        );
      })}
      <Text dimColor> Tab 补全  ↑↓ 导航  Enter 执行</Text>
    </Box>
  );
}
