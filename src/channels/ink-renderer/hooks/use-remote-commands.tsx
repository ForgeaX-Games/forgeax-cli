// @desc useRemoteCommands — poll the worker for command list, return CommandSpec[]

import { useEffect, useState, useRef, useCallback } from "react";
import type { CommandSpec } from "../../../capability/command/types.js";
import type { RendererCallbacks } from "../lib/renderer-config.js";

export interface UseRemoteCommandsOpts {
  callbacks: RendererCallbacks;
  /** Caller's perspective — typically activeAgentId from renderer state. */
  requestingAgentId?: string;
  /** Poll interval in ms. 0 = only fetch on demand. Default: 10_000. */
  pollMs?: number;
}

/**
 * Pulls the worker's command list periodically. Stateless on the worker side
 * (every list_commands re-scans dirs); renderer here owns its small cache for
 * autocomplete. Failures are swallowed — UI just shows fewer entries.
 *
 * Cancellation model: per-request sequence id (same as useCommandCall).
 * Effect cleanup bumps the seq, invalidating any in-flight call. This avoids
 * the stale-write hazard of a shared `cancelled` ref that gets reset across
 * effect re-runs.
 */
export function useRemoteCommands({
  callbacks,
  requestingAgentId,
  pollMs = 10_000,
}: UseRemoteCommandsOpts): { commands: CommandSpec[]; refresh: () => void } {
  const [commands, setCommands] = useState<CommandSpec[]>([]);
  const currentSeq = useRef(0);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (!callbacks.listCommands) return;
    const seq = ++currentSeq.current;
    try {
      const list = await callbacks.listCommands(requestingAgentId);
      if (seq === currentSeq.current) setCommands(list);
    } catch {
      // swallow — degraded UX is acceptable for autocomplete refresh failures
    }
  }, [callbacks, requestingAgentId]);

  useEffect(() => {
    void fetchOnce();
    if (pollMs > 0) {
      const id = setInterval(() => { void fetchOnce(); }, pollMs);
      return () => {
        currentSeq.current++; // invalidate any in-flight call
        clearInterval(id);
      };
    }
    return () => { currentSeq.current++; };
  }, [fetchOnce, pollMs]);

  return { commands, refresh: () => { void fetchOnce(); } };
}
