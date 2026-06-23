/**
 * ScreenLayout — pure visual layout component.
 *
 * Renders: AlternateScreen -> HistoryLayer / OverlayLayer / StatusLayer /
 * SuggestionsOverlay / InputBox.  Zero business logic.
 *
 * HistoryLayer is React.memo'd so overlay state changes skip the heavy
 * message-list reconciliation.  OverlaySection reads the scheduler from
 * context so the parent doesn't re-render when overlay state changes.
 */

import React, { useContext, memo } from "react";
import { default as Box } from "../ink/components/Box.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { AlternateScreen } from "../ink/components/AlternateScreen.js";
import type { CompletedTurn, InputSegment } from "../types.js";
import { HistoryLayer } from "./HistoryLayer.js";
import { StatusLayer } from "./StatusLayer.js";
import { ThinkingStrip } from "./ThinkingStrip.js";
import { InputBox } from "./InputBox.js";
import { OverlayLayer } from "./OverlayLayer.js";
import { CommandSuggestions } from "./CommandSuggestions.js";
import { ReservedQueuePanel } from "./ReservedQueuePanel.js";
import type { InputBoxControl } from "./InputBox.js";
import type { CommandSpec } from "../../../capability/command/types.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { usePromptOverlay } from "../hooks/prompt-overlay-context.js";
import { OverlaySchedulerContext } from "../lib/contexts.js";
import type { ReservedItem } from "../hooks/use-reserved-queue.js";

export interface ScreenLayoutProps {
  turns: CompletedTurn[];
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
  columns: number;
  streamText: string;
  isThinking: boolean;
  thinkingText: string;
  instanceId: string;
  activeAgent: string;
  contextPct: number;
  agentStatus: string;
  thinkingStartMs: number;
  lastCompletedTurnDurationMs: number;
  turnTokens: number;
  onSubmit: (text: string, segments: InputSegment[]) => void;
  onSteerSubmit: (text: string, segments: InputSegment[]) => void;
  onSlashCommand: (command: string) => void;
  reservedItems: ReservedItem[];
  onFlushReservedById: (id: string) => void;
  onFlushReservedHead: () => void;
  onRemoveReserved: (id: string) => void;
  /** Imperative handle for the draft persistence layer (read/replace input). */
  inputControlRef?: React.MutableRefObject<InputBoxControl | null>;
  /** Worker commands for autocomplete merging (passed through to InputBox). */
  remoteCommands?: readonly CommandSpec[];
}

export function ScreenLayout(props: ScreenLayoutProps): React.JSX.Element {
  return (
    <AlternateScreen mouseTracking={true}>
      <OverlayAwareLayout {...props} />
    </AlternateScreen>
  );
}

/**
 * OverlaySection — reads scheduler from context, renders overlay if active.
 * Isolated so scheduler state changes only re-render this subtree.
 */
function OverlaySection({ isFullscreen }: { isFullscreen: boolean }): React.JSX.Element | null {
  const scheduler = useContext(OverlaySchedulerContext);
  if (!scheduler) return null;
  const overlayActive = scheduler.current != null;
  if (!overlayActive) return null;

  if (isFullscreen) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center">
        <OverlayLayer scheduler={scheduler} />
      </Box>
    );
  }
  return <OverlayLayer scheduler={scheduler} />;
}

/**
 * OverlayAwareLayout — the inner layout that reads overlay state from context.
 * Memoized heavy children (HistoryLayer) are shielded from overlay re-renders.
 */
function OverlayAwareLayout(props: ScreenLayoutProps): React.JSX.Element {
  const {
    turns, scrollRef, columns, streamText,
    isThinking, thinkingText,
    activeAgent, contextPct, agentStatus,
    thinkingStartMs, lastCompletedTurnDurationMs, turnTokens,
    onSubmit, onSteerSubmit, onSlashCommand,
    reservedItems, onFlushReservedById, onFlushReservedHead, onRemoveReserved,
    inputControlRef, remoteCommands,
  } = props;

  const scheduler = useContext(OverlaySchedulerContext);
  const isFullscreen = scheduler?.current?.layout === "fullscreen";
  const overlayActive = scheduler?.current != null;

  const { rows: terminalRows } = useTerminalSize();
  const bottomBudget = Math.floor(terminalRows / 2);
  // ThinkingStrip (1) + StatusLayer (1) + ReservedQueuePanel (header + N rows)
  const reservedPanelRows = reservedItems.length > 0 ? 1 + reservedItems.length : 0;
  const reservedRows = 1 + (isThinking ? 1 : 0) + reservedPanelRows;
  const inputMaxRows = Math.max(bottomBudget - reservedRows, 3);

  return (
    <>
      {!isFullscreen && (
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          <HistoryLayer
            turns={turns}
            scrollRef={scrollRef}
            columns={columns}
            streamText={streamText}
          />
        </Box>
      )}

      {isFullscreen && <OverlaySection isFullscreen={true} />}

      {!isFullscreen && (
        <Box flexDirection="column" flexShrink={0} width="100%" maxHeight="50%">
          <OverlaySection isFullscreen={false} />
          {isThinking && <ThinkingStrip thinkingText={thinkingText} />}
          <StatusLayer
            agent={activeAgent}
            thinking={isThinking}
            contextPct={contextPct}
            agentStatus={agentStatus}
            thinkingStartMs={thinkingStartMs}
            lastCompletedTurnDurationMs={lastCompletedTurnDurationMs}
            turnTokens={turnTokens}
          />
          {/* Reserved-input queue lives between status bar and input box so
              the user can see at a glance what is buffered for the next turn. */}
          <ReservedQueuePanel
            items={reservedItems}
            onFlush={onFlushReservedById}
            onRemove={onRemoveReserved}
          />
          <SuggestionsOverlay />
          <Box flexDirection="column" width="100%" flexGrow={1} overflowY="hidden">
            <InputBox
              onSubmit={onSubmit}
              onSteerSubmit={onSteerSubmit}
              onSlashCommand={onSlashCommand}
              onFlushReserved={onFlushReservedHead}
              isActive={!overlayActive}
              columns={columns}
              maxRows={inputMaxRows}
              controlRef={inputControlRef}
              remoteCommands={remoteCommands}
            />
          </Box>
        </Box>
      )}
    </>
  );
}

function SuggestionsOverlay(): React.JSX.Element | null {
  const data = usePromptOverlay();
  if (!data || data.suggestions.length === 0) return null;
  return (
    <Box
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      paddingX={1}
      flexDirection="column"
      opaque={true}
    >
      <CommandSuggestions
        suggestions={data.suggestions}
        selectedIdx={data.selectedIdx}
      />
    </Box>
  );
}
