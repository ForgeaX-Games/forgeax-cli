/**
 * useDraftPersistence — persist (input box + reserved queue) per
 * (instance, agent) into the renderer cache; restore on (re)entry.
 *
 * Owns: nothing — pure side-effect orchestrator. Reads dataSource and
 *       writes through `inputControlRef` / `reservedQueue` setters.
 *
 * Single restore-effect handles three jobs:
 *   - mount   : seed UI from cache
 *   - tick    : ~2s heartbeat write (deduped by JSON of the snapshot)
 *   - cleanup : flush OLD-scope snapshot before the next pair takes over
 *               (closure captures OLD instanceId/activeAgent). Skipped on
 *               full unmount — detected by `inputControlRef.current === null`,
 *               since children unmount first — to avoid an empty-snapshot
 *               async write racing with `process.exit` and clobbering the
 *               sync flush that `wrappedOnExit` just performed.
 *
 * Restoration is imperative (`setSegments` / `setItems`) so InputBox is NOT
 * remounted — its Ctrl+C guards and other refs stay intact.
 *
 * `flushNowSync` is the only escape hatch we expose, for the explicit-exit
 * path (`wrappedOnExit` in app.tsx) where async writes lose to the
 * subsequent `process.exit`. Crashes / uncaught exceptions fall back to the
 * ~2s heartbeat — losing at most one heartbeat window of typing is the
 * accepted trade-off for keeping process-level event handling out of React.
 */

import { useCallback, useEffect, useRef } from "react";
import type { RendererDataSource, DraftSnapshot } from "../lib/renderer-config.js";
import type { ReservedQueueApi } from "./use-reserved-queue.js";
import type { InputBoxControl } from "../components/InputBox.js";

const HEARTBEAT_MS = 2_000;

interface Options {
  dataSource: RendererDataSource;
  instanceId: string;
  activeAgent: string;
  reservedQueue: ReservedQueueApi;
  inputControlRef: React.MutableRefObject<InputBoxControl | null>;
}

export function useDraftPersistence({
  dataSource, instanceId, activeAgent, reservedQueue, inputControlRef,
}: Options): { flushNowSync(): void } {
  const queueRef = useRef(reservedQueue);
  queueRef.current = reservedQueue;
  const lastWrittenRef = useRef("");
  const scopeRef = useRef({ instanceId, activeAgent });
  scopeRef.current = { instanceId, activeAgent };

  const snapshot = useCallback((): DraftSnapshot => {
    const segs = inputControlRef.current?.getSegments() ?? [];
    const items = queueRef.current.items;
    const out: DraftSnapshot = {};
    if (segs.length) out.inputSegments = segs;
    if (items.length) out.reservedQueue = items;
    return out;
  }, [inputControlRef]);

  const write = useCallback((i: string, a: string, snap: DraftSnapshot, sync: boolean) => {
    if (!i || !a) return;
    const key = JSON.stringify([i, a, snap]);
    if (key === lastWrittenRef.current) return;
    lastWrittenRef.current = key;
    try {
      if (sync) dataSource.writeDraftSync?.(i, a, snap);
      else void dataSource.writeDraft?.(i, a, snap).catch(() => {});
    } catch { /* fs errors are non-fatal — draft is best-effort */ }
  }, [dataSource]);

  useEffect(() => {
    if (!instanceId || !activeAgent) return;
    const draft = dataSource.readDraft?.(instanceId, activeAgent) ?? null;
    inputControlRef.current?.setSegments(draft?.inputSegments ?? []);
    queueRef.current.setItems(draft?.reservedQueue ?? []);

    // Seed dedup key from disk content so the first heartbeat tick doesn't
    // re-write identical data. Built from `draft` directly because the
    // `setSegments` / `setItems` calls above are reducer-deferred — refs
    // don't reflect them until next render.
    const restored: DraftSnapshot = {};
    if (draft?.inputSegments?.length) restored.inputSegments = draft.inputSegments;
    if (draft?.reservedQueue?.length) restored.reservedQueue = draft.reservedQueue;
    lastWrittenRef.current = JSON.stringify([instanceId, activeAgent, restored]);

    const id = setInterval(() => write(instanceId, activeAgent, snapshot(), false), HEARTBEAT_MS);
    return () => {
      clearInterval(id);
      // Distinguish two cleanup triggers via `inputControlRef.current`:
      //   - scope switch (instance / agent): InputBox stays mounted, ref is
      //     still valid → flush OLD scope so its draft survives the swap.
      //   - full unmount (Ctrl+D / process exit): React tears down children
      //     first, so InputBox's useImperativeHandle has already nulled the
      //     ref. `wrappedOnExit` already did a sync flush with live data;
      //     running an async write here would snapshot `[]` (ref is null)
      //     and clobber the good sync content via a process.exit race.
      if (!inputControlRef.current) return;
      write(instanceId, activeAgent, snapshot(), false);
    };
  }, [instanceId, activeAgent, dataSource, inputControlRef, snapshot, write]);

  const flushNowSync = useCallback(() => {
    const { instanceId: i, activeAgent: a } = scopeRef.current;
    write(i, a, snapshot(), true);
  }, [snapshot, write]);

  return { flushNowSync };
}
