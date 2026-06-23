/**
 * Shared animation clock — a single setInterval drives all Spinner and
 * ToolStatusIcon instances via useSyncExternalStore subscriptions.
 *
 * Each subscriber reads a snapshot (frame counter or blink boolean) from the
 * shared store without triggering setState in the animation components
 * themselves. React batches the re-renders of all subscribers into one
 * reconciliation pass per tick, and useSyncExternalStore only triggers a
 * re-render when the snapshot value actually changes.
 */

import { useSyncExternalStore } from "react";

const SPINNER_INTERVAL_MS = 80;
const BLINK_INTERVAL_MS = 500;

let spinnerFrame = 0;
let blinkVisible = true;
let spinnerListeners = new Set<() => void>();
let blinkListeners = new Set<() => void>();
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let blinkTimer: ReturnType<typeof setInterval> | null = null;

function startSpinnerClock() {
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % 256;
    for (const fn of spinnerListeners) fn();
  }, SPINNER_INTERVAL_MS);
}

function stopSpinnerClock() {
  if (spinnerTimer && spinnerListeners.size === 0) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

function startBlinkClock() {
  if (blinkTimer) return;
  blinkTimer = setInterval(() => {
    blinkVisible = !blinkVisible;
    for (const fn of blinkListeners) fn();
  }, BLINK_INTERVAL_MS);
}

function stopBlinkClock() {
  if (blinkTimer && blinkListeners.size === 0) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
}

function subscribeSpinner(listener: () => void): () => void {
  spinnerListeners.add(listener);
  startSpinnerClock();
  return () => {
    spinnerListeners.delete(listener);
    stopSpinnerClock();
  };
}

function subscribeBlink(listener: () => void): () => void {
  blinkListeners.add(listener);
  startBlinkClock();
  return () => {
    blinkListeners.delete(listener);
    stopBlinkClock();
  };
}

function getSpinnerSnapshot(): number {
  return spinnerFrame;
}

function getBlinkSnapshot(): boolean {
  return blinkVisible;
}

/**
 * Returns the current spinner frame index (mod frameCount).
 * All Spinner instances share a single setInterval.
 */
export function useSpinnerFrame(frameCount: number): number {
  const raw = useSyncExternalStore(subscribeSpinner, getSpinnerSnapshot);
  return raw % frameCount;
}

/**
 * Returns whether a blinking element should be visible.
 * All blink instances share a single 500ms setInterval.
 */
export function useBlinkVisible(): boolean {
  return useSyncExternalStore(subscribeBlink, getBlinkSnapshot);
}
