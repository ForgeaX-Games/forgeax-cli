/**
 * computeVirtualRange — pure function that determines the [start, end) slice
 * of items to mount given scroll state and a height cache.
 *
 * Binary search + pessimistic coverage back-walk + slide cap.
 * Zero React dependency — testable in isolation.
 */

const OVERSCAN_ROWS = 80
const COLD_START_COUNT = 30
const MAX_MOUNTED_ITEMS = 300
const PESSIMISTIC_HEIGHT = 1
const SLIDE_STEP = 25

export interface VirtualRangeInput {
  n: number
  offsets: ArrayLike<number>
  totalHeight: number
  viewportH: number
  scrollTop: number
  pendingDelta: number
  isSticky: boolean
  listOrigin: number
  heightCache: ReadonlyMap<string, number>
  itemKeys: readonly string[]
  /** The previously computed [start, end) range, or null on first call. */
  prevRange: readonly [number, number] | null
  /** Mounted item refs (key → exists) for unmeasured-guard logic. */
  mountedKeys: ReadonlySet<string>
  /** Scroll velocity (abs pixels moved since last commit). */
  scrollVelocity: number
  /** When true, a frozen range was active (column resize). */
  frozenRange: readonly [number, number] | null
}

export interface VirtualRangeResult {
  start: number
  end: number
}

export function computeVirtualRange(input: VirtualRangeInput): VirtualRangeResult {
  const {
    n, offsets, totalHeight, viewportH, scrollTop, pendingDelta,
    isSticky, listOrigin, heightCache, itemKeys, prevRange,
    mountedKeys, scrollVelocity, frozenRange,
  } = input

  let start: number
  let end: number

  if (frozenRange) {
    start = Math.min(frozenRange[0], n)
    end = Math.min(frozenRange[1], n)
    return { start, end }
  }

  if (viewportH === 0 || scrollTop < 0) {
    start = Math.max(0, n - COLD_START_COUNT)
    end = n
    return { start, end }
  }

  if (isSticky) {
    const budget = viewportH + OVERSCAN_ROWS
    start = n
    while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
      start--
    }
    end = n
  } else {
    const MAX_SPAN_ROWS = viewportH * 3
    const rawLo = Math.min(scrollTop, scrollTop + pendingDelta)
    const rawHi = Math.max(scrollTop, scrollTop + pendingDelta)
    const span = rawHi - rawLo
    const clampedLo =
      span > MAX_SPAN_ROWS
        ? pendingDelta < 0
          ? rawHi - MAX_SPAN_ROWS
          : rawLo
        : rawLo
    const clampedHi = clampedLo + Math.min(span, MAX_SPAN_ROWS)
    const effLo = Math.max(0, clampedLo - listOrigin)
    const effHi = clampedHi - listOrigin
    const lo = effLo - OVERSCAN_ROWS

    // Binary search for start
    {
      let l = 0
      let r = n
      while (l < r) {
        const m = (l + r) >> 1
        if (offsets[m + 1]! <= lo) l = m + 1
        else r = m
      }
      start = l
    }

    // Guard: don't advance past mounted-but-unmeasured items
    if (prevRange && prevRange[0] < start) {
      for (let i = prevRange[0]; i < Math.min(start, prevRange[1]); i++) {
        const k = itemKeys[i]!
        if (mountedKeys.has(k) && !heightCache.has(k)) {
          start = i
          break
        }
      }
    }

    const needed = viewportH + 2 * OVERSCAN_ROWS
    const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS)
    let coverage = 0
    end = start
    while (
      end < maxEnd &&
      (coverage < needed || offsets[end]! < effHi + viewportH + OVERSCAN_ROWS)
    ) {
      coverage += heightCache.get(itemKeys[end]!) ?? PESSIMISTIC_HEIGHT
      end++
    }
  }

  // Coverage guarantee for both paths
  const needed = viewportH + 2 * OVERSCAN_ROWS
  const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS)
  let coverage = 0
  for (let i = start; i < end; i++) {
    coverage += heightCache.get(itemKeys[i]!) ?? PESSIMISTIC_HEIGHT
  }
  while (start > minStart && coverage < needed) {
    start--
    coverage += heightCache.get(itemKeys[start]!) ?? PESSIMISTIC_HEIGHT
  }

  // Slide cap: limit new items per commit during fast scroll
  if (prevRange && scrollVelocity > viewportH * 2) {
    const [pS, pE] = prevRange
    if (start < pS - SLIDE_STEP) start = pS - SLIDE_STEP
    if (end > pE + SLIDE_STEP) end = pE + SLIDE_STEP
    if (start > end) end = Math.min(start + SLIDE_STEP, n)
  }

  return { start, end }
}
