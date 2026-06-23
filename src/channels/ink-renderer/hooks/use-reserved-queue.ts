/**
 * useReservedQueue — FIFO buffer for user inputs typed while the agent is busy.
 *
 * Pure state, no effects: the caller decides what to do with a popped item
 * (typically: dispatch through the onSubmit pipeline). Items carry a stable
 * `id` so React keys survive reorders, and `visualDisplay` is precomputed so
 * the panel never does segment work on render.
 */

import { useCallback, useState, useRef } from "react";
import type { InputSegment } from "../types.js";
import { segmentsToVisualDisplay } from "../../shared/input-segments.js";

export interface ReservedItem {
  id: string;
  text: string;
  segments: InputSegment[];
  visualDisplay: string;
  createdAt: number;
}

export interface ReservedQueueApi {
  items: ReservedItem[];
  size: number;
  enqueue(text: string, segments: InputSegment[]): ReservedItem;
  dequeueHead(): ReservedItem | null;
  /** Remove a queued item by id (used by both `[del]` and `[send]` rows). */
  removeById(id: string): ReservedItem | null;
  /** Replace the queue wholesale — used by draft restoration. */
  setItems(items: ReservedItem[]): void;
}

let nextId = 0;
function makeId(): string {
  nextId = (nextId + 1) | 0;
  return `rq-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export function useReservedQueue(): ReservedQueueApi {
  const [items, set] = useState<ReservedItem[]>([]);

  // Keep a ref so callers (Ctrl+C guards, key handlers) reading from a closure
  // see the latest queue without re-binding effects on every state change.
  const ref = useRef<ReservedItem[]>(items);
  ref.current = items;

  const enqueue = useCallback((text: string, segments: InputSegment[]): ReservedItem => {
    const item: ReservedItem = {
      id: makeId(), text, segments,
      visualDisplay: segmentsToVisualDisplay(segments),
      createdAt: Date.now(),
    };
    set(prev => [...prev, item]);
    return item;
  }, []);

  const removeById = useCallback((id: string): ReservedItem | null => {
    const idx = ref.current.findIndex(i => i.id === id);
    if (idx < 0) return null;
    const removed = ref.current[idx]!;
    set(prev => prev.filter((_, i) => i !== idx));
    return removed;
  }, []);

  const dequeueHead = useCallback((): ReservedItem | null => {
    if (ref.current.length === 0) return null;
    const head = ref.current[0]!;
    set(prev => prev.slice(1));
    return head;
  }, []);

  return {
    items,
    size: items.length,
    enqueue,
    dequeueHead,
    removeById,
    setItems: set,
  };
}
