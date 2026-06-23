/**
 * useCtrlCChain — layered Ctrl+C interception following the overlay stack.
 *
 * Model: the screen is a stack of layers (bottom = main view, top = overlay).
 * Each layer owns its component guards. On Ctrl+C only the topmost layer's
 * guards run. Components register on the layer they live in via context.
 *
 * The app pushes/pops layers as overlays open/close. The main view is always
 * the bottom layer pushed at mount.
 */

import { useRef, useCallback, useMemo, createContext } from "react";

export type CtrlCGuard = () => boolean;

export interface CtrlCLayerApi {
  register(id: string, order: number, guard: CtrlCGuard): void;
  unregister(id: string): void;
}

/** Components use this context to register guards on their containing layer. */
export const CtrlCLayerContext = createContext<CtrlCLayerApi>({
  register: () => {},
  unregister: () => {},
});

interface Layer {
  id: string;
  guards: Map<string, { order: number; guard: CtrlCGuard }>;
}

function makeLayerApi(layer: Layer): CtrlCLayerApi {
  return {
    register(id, order, guard) { layer.guards.set(id, { order, guard }); },
    unregister(id) { layer.guards.delete(id); },
  };
}

export function useCtrlCChain() {
  const stack = useRef<Layer[]>([]);

  /** Push a new layer (returns its API for guard registration). */
  const pushLayer = useCallback((id: string): CtrlCLayerApi => {
    const layer: Layer = { id, guards: new Map() };
    stack.current = [...stack.current, layer];
    return makeLayerApi(layer);
  }, []);

  /** Remove a layer by id. */
  const popLayer = useCallback((id: string) => {
    stack.current = stack.current.filter(l => l.id !== id);
  }, []);

  /**
   * Dispatch Ctrl+C to the topmost layer's guards (sorted by order).
   * Returns true if any guard consumed the event.
   */
  const dispatch = useCallback((): boolean => {
    const top = stack.current[stack.current.length - 1];
    if (!top) return false;
    const sorted = [...top.guards.values()].sort((a, b) => a.order - b.order);
    for (const { guard } of sorted) {
      if (guard()) return true;
    }
    return false;
  }, []);

  return { pushLayer, popLayer, dispatch } as const;
}
