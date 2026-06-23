import React, { useState } from "react";
import { default as Box } from "../ink/components/Box.js";

interface CollapsibleProps {
  summary: React.ReactNode;
  collapsedSummary?: React.ReactNode;
  preview?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Generic collapsible container with per-item click-to-toggle.
 * Collapsed: renders `collapsedSummary` (falls back to `summary`) + optional `preview`.
 * Expanded: renders `summary` + `children`.
 */
export function Collapsible({ summary, collapsedSummary, preview, children }: CollapsibleProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box flexDirection="column" width="100%">
      <Box onClick={() => setExpanded(e => !e)} flexGrow={1}>
        {expanded ? summary : (collapsedSummary ?? summary)}
      </Box>
      {expanded ? children : (preview ?? null)}
    </Box>
  );
}
