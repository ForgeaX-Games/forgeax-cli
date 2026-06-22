/**
 * HistoryLayer — scrollable history area wrapping VirtualMessageList.
 * Occupies flexGrow=1 of the available vertical space.
 *
 * React.memo prevents re-renders from sibling state changes (Spinner ticks,
 * isThinking, agentStatus, overlay state) that don't affect the message list.
 * Focusable via tabIndex/onClick; Home/End scroll to top/bottom while focused.
 */

import React, { memo, useCallback, useRef, type RefObject } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as ScrollBox, type ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { VirtualMessageList } from "./VirtualMessageList.js";
import type { CompletedTurn } from "../types.js";
import type { DOMElement } from "../ink/dom.js";
import { getFocusManager } from "../ink/focus.js";
import type { KeyboardEvent } from "../ink/events/keyboard-event.js";

interface HistoryLayerProps {
  turns: CompletedTurn[];
  scrollRef: RefObject<ScrollBoxHandle | null>;
  columns: number;
  streamText: string;
}

export const HistoryLayer = memo(function HistoryLayer({
  turns,
  scrollRef,
  columns,
  streamText,
}: HistoryLayerProps): React.JSX.Element {
  const boxRef = useRef<DOMElement | null>(null);

  const focusSelf = useCallback(() => {
    const node = boxRef.current;
    if (node) getFocusManager(node).focus(node);
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const sb = scrollRef.current;
    if (!sb) return;
    if (e.key === "home") { sb.scrollTo(0); e.preventDefault(); }
    else if (e.key === "end") { sb.scrollToBottom(); e.preventDefault(); }
  }, [scrollRef]);

  return (
    <Box ref={boxRef} flexGrow={1} flexDirection="column" tabIndex={0} onClick={focusSelf} onKeyDown={handleKeyDown}>
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll={true}>
        <VirtualMessageList turns={turns} scrollRef={scrollRef} columns={columns} streamText={streamText} />
        <Box flexGrow={1} />
      </ScrollBox>
    </Box>
  );
});
