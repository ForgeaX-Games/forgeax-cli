/**
 * PanelOverlay — generic container for panel-type overlays (/tree, /board, etc.).
 * Renders a bordered box with title, scrollable children area, and Esc hint.
 */

import React from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { theme } from "../lib/theme.js";

interface PanelOverlayProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function PanelOverlay({ title, onClose, children }: PanelOverlayProps): React.JSX.Element {
  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  return (
    <Box flexDirection="column" borderStyle={theme.overlay.borderStyle} borderColor={theme.overlay.borderColor} flexGrow={1}>
      <Box>
        <Text bold> {title} </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        {children}
      </Box>
      <Box justifyContent="flex-end" flexShrink={0}>
        <Text dimColor> Esc 关闭 </Text>
      </Box>
    </Box>
  );
}
