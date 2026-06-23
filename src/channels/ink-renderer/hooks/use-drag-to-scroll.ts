/**
 * Drag-to-scroll — auto-scroll the ScrollBox when dragging a text selection
 * past viewport edges.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import type { SelectionState } from '../ink/selection.js'

const AUTOSCROLL_LINES = 2
const AUTOSCROLL_INTERVAL_MS = 50
const AUTOSCROLL_MAX_TICKS = 200

/**
 * Determine autoscroll direction for a drag selection relative to the
 * ScrollBox viewport.  Returns 0 when idle, -1 to scroll up, +1 to
 * scroll down.
 */
export function dragScrollDirection(
  sel: SelectionState | null,
  top: number,
  bottom: number,
  alreadyScrollingDir: -1 | 0 | 1 = 0,
): -1 | 0 | 1 {
  if (!sel?.isDragging || !sel.anchor || !sel.focus) return 0
  const row = sel.focus.row
  const want: -1 | 0 | 1 = row < top ? -1 : row > bottom ? 1 : 0
  if (alreadyScrollingDir !== 0) {
    return want === alreadyScrollingDir ? want : 0
  }
  if (sel.anchor.row < top || sel.anchor.row > bottom) return 0
  return want
}

export function useDragToScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  selection: ReturnType<typeof useSelection>,
  isActive: boolean,
): void {
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const dirRef = useRef<-1 | 0 | 1>(0)
  const lastScrolledDirRef = useRef<-1 | 0 | 1>(0)
  const ticksRef = useRef(0)

  useEffect(() => {
    if (!isActive) return

    function stop(): void {
      dirRef.current = 0
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }

    function tick(): void {
      const sel = selection.getState()
      const s = scrollRef.current
      const dir = dirRef.current
      if (!sel?.isDragging || !sel.focus || !s || dir === 0 || ++ticksRef.current > AUTOSCROLL_MAX_TICKS) {
        stop()
        return
      }
      if (s.getPendingDelta() !== 0) return

      const top = s.getViewportTop()
      const bottom = top + s.getViewportHeight() - 1

      if (dir < 0) {
        if (s.getScrollTop() <= 0) { stop(); return }
        const actual = Math.min(AUTOSCROLL_LINES, s.getScrollTop())
        selection.captureScrolledRows(bottom - actual + 1, bottom, 'below')
        selection.shiftAnchor(actual, 0, bottom)
        s.scrollBy(-AUTOSCROLL_LINES)
      } else {
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
        if (s.getScrollTop() >= max) { stop(); return }
        const actual = Math.min(AUTOSCROLL_LINES, max - s.getScrollTop())
        selection.captureScrolledRows(top, top + actual - 1, 'above')
        selection.shiftAnchor(-actual, top, bottom)
        s.scrollBy(AUTOSCROLL_LINES)
      }
    }

    function start(newDir: -1 | 1): void {
      lastScrolledDirRef.current = newDir
      if (dirRef.current === newDir) return
      stop()
      dirRef.current = newDir
      ticksRef.current = 0
      tick()
      if (dirRef.current === newDir) {
        timerRef.current = setInterval(tick, AUTOSCROLL_INTERVAL_MS)
      }
    }

    function check(): void {
      const s = scrollRef.current
      if (!s) { stop(); return }
      const top = s.getViewportTop()
      const bottom = top + s.getViewportHeight() - 1
      const sel = selection.getState()

      if (
        !sel?.isDragging ||
        (sel.scrolledOffAbove.length === 0 && sel.scrolledOffBelow.length === 0)
      ) {
        lastScrolledDirRef.current = 0
      }

      const dir = dragScrollDirection(sel, top, bottom, lastScrolledDirRef.current)
      if (dir === 0) {
        if (lastScrolledDirRef.current !== 0 && sel?.focus) {
          const want = sel.focus.row < top ? -1 : sel.focus.row > bottom ? 1 : 0
          if (want !== 0 && want !== lastScrolledDirRef.current) {
            sel.scrolledOffAbove = []
            sel.scrolledOffBelow = []
            sel.scrolledOffAboveSW = []
            sel.scrolledOffBelowSW = []
            lastScrolledDirRef.current = 0
          }
        }
        stop()
      } else {
        start(dir)
      }
    }

    const unsubscribe = selection.subscribe(check)
    return () => {
      unsubscribe()
      stop()
      lastScrolledDirRef.current = 0
    }
  }, [isActive, scrollRef, selection])
}
