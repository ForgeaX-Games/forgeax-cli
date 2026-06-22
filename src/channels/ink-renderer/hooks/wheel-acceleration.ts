/**
 * Wheel acceleration — pure functions / types for scroll speed calculation.
 *
 * Two paths:
 *   - Native terminal (trackpad/hi-res + mouse wheel-mode): original curves,
 *     unchanged.
 *   - xterm.js (VS Code / Cursor / Windsurf integrated terminal): fixed
 *     1 row per wheel event. The browser already emits one wheel event per
 *     scroll "tick", so multiplying by an acceleration curve is what made
 *     touch/trackpad scrolling feel "forceful and segmented". A flat 1-row
 *     step is predictable and tied directly to the gesture.
 *
 * Users who want faster xterm.js scrolling can set AGENTEAM_SCROLL_SPEED
 * (e.g. 3) to multiply the per-event step.
 */

// ─── Native terminal: hard-window linear ramp ───
const WHEEL_ACCEL_WINDOW_MS = 40
const WHEEL_ACCEL_STEP = 0.3
const WHEEL_ACCEL_MAX = 6

// ─── Encoder bounce debounce + wheel-mode decay curve ───
const WHEEL_BOUNCE_GAP_MAX_MS = 200
const WHEEL_MODE_STEP = 15
const WHEEL_MODE_CAP = 15
const WHEEL_MODE_RAMP = 3
const WHEEL_MODE_IDLE_DISENGAGE_MS = 1500
const WHEEL_DECAY_HALFLIFE_MS = 150
const WHEEL_BURST_MS = 5

export type WheelAccelState = {
  time: number
  mult: number
  dir: 0 | 1 | -1
  xtermJs: boolean
  frac: number
  base: number
  pendingFlip: boolean
  wheelMode: boolean
  burstCount: number
}

export function initWheelAccel(
  xtermJs = false,
  base = 1,
): WheelAccelState {
  return {
    time: 0,
    mult: base,
    dir: 0,
    xtermJs,
    frac: 0,
    base,
    pendingFlip: false,
    wheelMode: false,
    burstCount: 0,
  }
}

export function computeWheelStep(
  state: WheelAccelState,
  dir: 1 | -1,
  now: number,
): number {
  // ─── xterm.js: flat 1-row step (scaled by base) ───
  // One wheel event → one row. No acceleration, no heuristics. This is what
  // makes touch/trackpad scrolling in VS Code/Cursor Web feel 1:1 with the
  // gesture. Users can scale via AGENTEAM_SCROLL_SPEED / CLAUDE_CODE_SCROLL_SPEED.
  if (state.xtermJs) {
    state.time = now
    state.dir = dir
    const total = state.frac + state.base
    const rows = Math.floor(total)
    state.frac = total - rows
    return Math.max(1, rows)
  }

  // ─── Native terminal: original curves (unchanged) ───
  if (
    state.wheelMode &&
    now - state.time > WHEEL_MODE_IDLE_DISENGAGE_MS
  ) {
    state.wheelMode = false
    state.burstCount = 0
    state.mult = state.base
  }

  if (state.pendingFlip) {
    state.pendingFlip = false
    if (dir !== state.dir || now - state.time > WHEEL_BOUNCE_GAP_MAX_MS) {
      state.dir = dir
      state.time = now
      state.mult = state.base
      return Math.floor(state.mult)
    }
    state.wheelMode = true
  }

  const gap = now - state.time
  if (dir !== state.dir && state.dir !== 0) {
    state.pendingFlip = true
    state.time = now
    return 0
  }
  state.dir = dir
  state.time = now

  // ─── MOUSE (wheel mode) ───
  if (state.wheelMode) {
    if (gap < WHEEL_BURST_MS) {
      if (++state.burstCount >= 5) {
        state.wheelMode = false
        state.burstCount = 0
        state.mult = state.base
      } else {
        return 1
      }
    } else {
      state.burstCount = 0
    }
  }
  if (state.wheelMode) {
    const m = Math.pow(0.5, gap / WHEEL_DECAY_HALFLIFE_MS)
    const cap = Math.max(WHEEL_MODE_CAP, state.base * 2)
    const next = 1 + (state.mult - 1) * m + WHEEL_MODE_STEP * m
    state.mult = Math.min(cap, next, state.mult + WHEEL_MODE_RAMP)
    return Math.floor(state.mult)
  }

  // ─── TRACKPAD / HI-RES (native, non-wheel-mode) ───
  if (gap > WHEEL_ACCEL_WINDOW_MS) {
    state.mult = state.base
  } else {
    const cap = Math.max(WHEEL_ACCEL_MAX, state.base * 2)
    state.mult = Math.min(cap, state.mult + WHEEL_ACCEL_STEP)
  }
  return Math.floor(state.mult)
}

export function isXtermJs(): boolean {
  return (
    !!process.env['VSCODE_PID'] ||
    !!process.env['TERM_PROGRAM']?.match(/vscode|cursor|windsurf/i)
  )
}

export function readScrollSpeedBase(): number {
  // AGENTEAM_SCROLL_SPEED takes precedence; CLAUDE_CODE_SCROLL_SPEED is legacy.
  const raw = process.env['AGENTEAM_SCROLL_SPEED'] ?? process.env['CLAUDE_CODE_SCROLL_SPEED']
  if (!raw) return 1
  const n = parseFloat(raw)
  return Number.isNaN(n) || n <= 0 ? 1 : Math.min(n, 20)
}

export function jumpBy(s: { getScrollHeight(): number; getViewportHeight(): number; getScrollTop(): number; getPendingDelta(): number; scrollTo(n: number): void; scrollToBottom(): void }, delta: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
  const target = s.getScrollTop() + s.getPendingDelta() + delta
  if (target >= max) {
    s.scrollTo(max)
    s.scrollToBottom()
    return true
  }
  s.scrollTo(Math.max(0, target))
  return false
}

export function scrollDown(s: { getScrollTop(): number; getPendingDelta(): number; getScrollHeight(): number; getViewportHeight(): number; scrollToBottom(): void; scrollBy(n: number): void }, amount: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
  const effectiveTop = s.getScrollTop() + s.getPendingDelta()
  if (effectiveTop + amount >= max) {
    s.scrollToBottom()
    return true
  }
  s.scrollBy(amount)
  return false
}

export function scrollUp(s: { getScrollTop(): number; getPendingDelta(): number; scrollTo(n: number): void; scrollBy(n: number): void }, amount: number): void {
  const effectiveTop = s.getScrollTop() + s.getPendingDelta()
  if (effectiveTop - amount <= 0) {
    s.scrollTo(0)
    return
  }
  s.scrollBy(-amount)
}
