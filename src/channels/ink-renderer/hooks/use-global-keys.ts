/**
 * useGlobalKeys — global keyboard routing layer.
 *
 * Owns: CtrlC chain, scroll keys, global useInput.
 * ESC for overlay close is handled by OverlayLayer's own components.
 *
 * ── Ctrl+C chain (main-view layer, lower order = higher priority) ──
 *   20  input-clear     (registered by InputBox) → wipes input box if non-empty
 *   25  reserved-pop    (here)                   → drops queue head when agent IDLE
 *   30  interrupt-agent (here)                   → cancels current agent turn
 *   ──  fallback                                 → onExit?.()
 *
 *   Rationale for the reserved-pop slot: while the agent is RUNNING the user
 *   presses Ctrl+C to interrupt — and per spec the queue MUST NOT auto-flush
 *   on interrupt. The queue-pop guard therefore short-circuits when running,
 *   leaving interrupt-agent to take over.
 *
 * ── Ctrl+D ──
 *   Always exits the renderer regardless of state. Provided as an
 *   unambiguous escape hatch now that Ctrl+C carries multiple meanings.
 */

import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import useInput from "../ink/hooks/use-input.js";
import { useCtrlCChain, type CtrlCLayerApi } from "./use-ctrl-c-chain.js";
import { useScrollKeys } from "./use-scroll-keys.js";
import type { OverlaySchedulerResult } from "./use-overlay-scheduler.js";
import type { ReservedQueueApi } from "./use-reserved-queue.js";

export interface GlobalKeysResult {
  mainLayerApi: CtrlCLayerApi;
  hasSelection: () => boolean;
  copySelection: () => string;
}

export function useGlobalKeys(opts: {
  scrollRef: RefObject<ScrollBoxHandle | null>;
  scheduler: OverlaySchedulerResult;
  onExit?: () => void;
  onInterrupt?: () => void;
  isThinking: boolean;
  reservedQueue?: ReservedQueueApi;
}): GlobalKeysResult {
  const { scrollRef, scheduler, onExit, onInterrupt, isThinking, reservedQueue } = opts;

  const isFullscreenOverlay = scheduler.isActive() && scheduler.current?.layout === "fullscreen";
  const { hasSelection, copySelection } = useScrollKeys(scrollRef, !isFullscreenOverlay);

  const ctrlC = useCtrlCChain();

  const mainLayerApi = useMemo(() => {
    return ctrlC.pushLayer("main-view");
  }, []);

  const isThinkingRef = useRef(isThinking);
  isThinkingRef.current = isThinking;
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;
  const reservedQueueRef = useRef(reservedQueue);
  reservedQueueRef.current = reservedQueue;
  const lastInterruptRef = useRef(0);

  useEffect(() => {
    mainLayerApi.register("interrupt-agent", 30, () => {
      if (!isThinkingRef.current) return false;
      const now = Date.now();
      if (now - lastInterruptRef.current < 2000) return false;
      lastInterruptRef.current = now;
      onInterruptRef.current?.();
      return true;
    });
    return () => mainLayerApi.unregister("interrupt-agent");
  }, [mainLayerApi]);

  // queue-pop guard: only fires when agent is IDLE. When the user presses
  // Ctrl+C with the agent stopped, drop the head of the reserved queue (if
  // any). When the agent is running, return false so interrupt-agent runs.
  useEffect(() => {
    mainLayerApi.register("reserved-pop", 25, () => {
      if (isThinkingRef.current) return false;
      const q = reservedQueueRef.current;
      if (!q || q.size === 0) return false;
      q.dequeueHead();
      return true;
    });
    return () => mainLayerApi.unregister("reserved-pop");
  }, [mainLayerApi]);

  useInput((input, key) => {
    // Ctrl+D — unconditional exit (always-available escape hatch).
    if (input === "d" && key.ctrl) {
      onExit?.();
      return;
    }
    if (input === "c" && key.ctrl) {
      if (hasSelection()) { copySelection(); return; }
      if (!ctrlC.dispatch()) onExit?.();
    }
  }, { isActive: true });

  return { mainLayerApi, hasSelection, copySelection };
}
