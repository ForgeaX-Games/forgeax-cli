/**
 * Overlay Stack Scheduler — manages a stack of overlay requests.
 *
 *   - push()       inserts overlays at the top of the stack
 *   - confirm(idx) calls onConfirm; if onConfirm pushed a sub-flow the
 *     current overlay is kept (returns on cancel/complete), otherwise popped
 *   - cancel()     pops the top overlay, revealing the one beneath
 */

import { useState, useCallback, useRef } from "react";
import type { OverlayRequest, SelectItem } from "../types.js";
import instances from "../ink/instances.js";

/**
 * Overlay stack mutations change large absolute/fullscreen regions at once.
 * The Ink renderer's blit fast path can otherwise reuse cells from a previous
 * overlay frame (especially after text selection overlays mutate cell styles
 * without per-cell damage tracking). Mark prevFrame untrusted so the next
 * render does a one-shot full-damage diff — lighter than forceRedraw(), and
 * exactly what ink/ink.tsx recommends for unmounting tall overlays.
 */
function invalidateOverlayFrame(): void {
  instances.get(process.stdout)?.invalidatePrevFrame();
}

export interface OverlaySchedulerResult {
  current: OverlayRequest | null;
  isLoading: boolean;
  items: SelectItem[];
  push: (...reqs: OverlayRequest[]) => void;
  confirm: (idx: number) => void;
  cancel: () => void;
  /** Clear the entire stack (dismiss all overlays). */
  clear: () => void;
  isActive: () => boolean;
}

export function useOverlayScheduler(): OverlaySchedulerResult {
  const [queue, setQueue] = useState<OverlayRequest[]>([]);
  const [items, setItems] = useState<SelectItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pushCalledRef = useRef(false);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const activateHead = useCallback((q: OverlayRequest[]) => {
    clearPollTimer();

    if (q.length === 0) {
      setItems([]);
      setIsLoading(false);
      return;
    }
    const head = q[0]!;
    if (head.kind === "panel") {
      setItems([]);
      setIsLoading(false);
      return;
    }
    if (head.items) {
      setItems(head.items);
      setIsLoading(false);
    } else if (head.loadItems) {
      setIsLoading(true);
      setItems([]);
      const loader = head.loadItems;
      loader().then(
        (loaded) => {
          if (queueRef.current[0]?.id === head.id) {
            setItems(loaded);
            setIsLoading(false);
          }
        },
        () => {
          if (queueRef.current[0]?.id === head.id) {
            setItems([]);
            setIsLoading(false);
          }
        },
      );

      if (head.pollMs && head.pollMs > 0) {
        pollTimerRef.current = setInterval(() => {
          if (queueRef.current[0]?.id !== head.id) {
            clearPollTimer();
            return;
          }
          loader().then(
            (loaded) => {
              if (queueRef.current[0]?.id === head.id) {
                setItems(loaded);
              }
            },
            () => {},
          );
        }, head.pollMs);
      }
    } else {
      setItems([]);
      setIsLoading(false);
    }
  }, [clearPollTimer]);

  const push = useCallback((...reqs: OverlayRequest[]) => {
    pushCalledRef.current = true;
    setQueue(prev => {
      const incomingIds = new Set(reqs.map(req => req.id));
      const next = [...reqs, ...prev.filter(req => !incomingIds.has(req.id))];
      invalidateOverlayFrame();
      queueRef.current = next;
      activateHead(next);
      return next;
    });
  }, [activateHead]);

  const confirm = useCallback((idx: number) => {
    const q = queueRef.current;
    if (q.length === 0) return;

    const head = q[0]!;
    const item = items[idx];
    if (!item) return;

    clearPollTimer();
    pushCalledRef.current = false;

    head.onConfirm?.(idx, item);

    if (!pushCalledRef.current) {
      const next = queueRef.current.slice(1);
      invalidateOverlayFrame();
      queueRef.current = next;
      setQueue(next);
      activateHead(next);
    }
  }, [items, activateHead, clearPollTimer]);

  const cancel = useCallback(() => {
    const q = queueRef.current;
    if (q.length === 0) return;

    const head = q[0]!;
    clearPollTimer();
    const next = q.slice(1);
    invalidateOverlayFrame();
    queueRef.current = next;
    setQueue(next);
    activateHead(next);

    head.onCancel?.();
  }, [activateHead, clearPollTimer]);

  const clear = useCallback(() => {
    clearPollTimer();
    invalidateOverlayFrame();
    queueRef.current = [];
    setQueue([]);
    setItems([]);
    setIsLoading(false);
  }, [clearPollTimer]);

  const isActive = useCallback(() => queueRef.current.length > 0, []);

  const current = queue.length > 0 ? queue[0]! : null;

  return { current, isLoading, items, push, confirm, cancel, clear, isActive };
}
