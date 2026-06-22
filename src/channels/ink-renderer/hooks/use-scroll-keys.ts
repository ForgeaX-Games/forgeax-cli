/**
 * Scroll keybinding hook — maps keyboard/wheel events to ScrollBox API.
 *
 * Orchestrates wheel-acceleration (pure math), drag-to-scroll (auto-scroll
 * on selection drag), and keyboard navigation (PageUp/Down only).
 *
 * Note: Home/End are intentionally NOT handled here — they are reserved for
 * the input box cursor (start/end of line). History scroll uses PageUp/Down
 * exclusively to avoid the dual-trigger conflict where a single Home/End
 * keypress would simultaneously move the input cursor AND jump the history
 * viewport.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import useInput from '../ink/hooks/use-input.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import { useCopyOnSelect } from './use-copy-on-select.js'
import { getTheme } from '../utils/theme.js'
import { useTheme } from '../ink/ink-compat.js'
import {
  type WheelAccelState,
  initWheelAccel,
  computeWheelStep,
  isXtermJs,
  readScrollSpeedBase,
  jumpBy,
  scrollDown,
  scrollUp,
} from './wheel-acceleration.js'
import { useDragToScroll } from './use-drag-to-scroll.js'

export { type WheelAccelState, computeWheelStep, initWheelAccel, jumpBy }
export { dragScrollDirection } from './use-drag-to-scroll.js'

export interface ScrollKeysResult {
  hasSelection: () => boolean;
  copySelection: () => string;
  clearSelection: () => void;
}

export function useScrollKeys(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  isActive: boolean,
): ScrollKeysResult {
  const wheelAccel = useRef<WheelAccelState | null>(null)
  const selection = useSelection()

  const [themeName] = useTheme()
  useEffect(() => {
    const theme = getTheme(themeName)
    selection.setSelectionBgColor(theme.selectionBg)
  }, [themeName, selection])

  useCopyOnSelect(selection, isActive)
  useDragToScroll(scrollRef, selection, isActive)

  useInput((input, key) => {
    const sb = scrollRef.current
    if (!sb) return

    if (key.escape && selection.hasSelection()) {
      selection.clearSelection()
      return
    }

    if (key.pageUp) {
      selection.clearSelection()
      const d = -Math.max(1, Math.floor(sb.getViewportHeight() / 2))
      jumpBy(sb, d)
    } else if (key.pageDown) {
      selection.clearSelection()
      const d = Math.max(1, Math.floor(sb.getViewportHeight() / 2))
      jumpBy(sb, d)
    } else if (key.wheelUp) {
      if (sb.getScrollHeight() <= sb.getViewportHeight()) return
      wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
      const step = computeWheelStep(wheelAccel.current, -1, performance.now())
      scrollUp(sb, step)
    } else if (key.wheelDown) {
      if (sb.getScrollHeight() <= sb.getViewportHeight()) return
      wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
      const step = computeWheelStep(wheelAccel.current, 1, performance.now())
      scrollDown(sb, step)
    }
    // Home/End deliberately omitted — reserved for input-box cursor control.
  }, { isActive })

  return {
    hasSelection: selection.hasSelection,
    copySelection: selection.copySelection,
    clearSelection: selection.clearSelection,
  }
}
