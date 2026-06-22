/**
 * useCopyOnSelect — auto-copy text selection to clipboard on mouse-up.
 *
 * Ported from claude-code. Subscribes to Ink's selection state; when a
 * drag finishes (isDragging goes false with active selection), copies
 * the selected text via OSC 52. Multi-click word/line selection also
 * triggers copy.
 *
 * The `onCopied` callback is optional — when provided, it can be used
 * to display a "Copied" notification.
 */

import { useEffect, useRef } from "react";
import type { useSelection } from "../ink/hooks/use-selection.js";

type Selection = ReturnType<typeof useSelection>;

export function useCopyOnSelect(
  selection: Selection,
  isActive: boolean,
  onCopied?: (text: string) => void,
): void {
  const copiedRef = useRef(false);
  const onCopiedRef = useRef(onCopied);
  onCopiedRef.current = onCopied;

  useEffect(() => {
    if (!isActive) return;

    const unsubscribe = selection.subscribe(() => {
      const sel = selection.getState();
      const has = selection.hasSelection();

      if (sel?.isDragging) {
        copiedRef.current = false;
        return;
      }

      if (!has) {
        copiedRef.current = false;
        return;
      }

      if (copiedRef.current) return;

      const text = selection.copySelectionNoClear();
      if (!text || !text.trim()) {
        copiedRef.current = true;
        return;
      }
      copiedRef.current = true;
      onCopiedRef.current?.(text);
    });
    return unsubscribe;
  }, [isActive, selection]);
}
