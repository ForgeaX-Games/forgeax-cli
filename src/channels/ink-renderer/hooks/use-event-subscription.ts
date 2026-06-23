/**
 * Subscribes to live events from the gateway and feeds them through
 * TurnAccumulator, which drives React state updates via dispatch callbacks.
 */

import { useEffect, useRef } from "react";
import type { RendererCallbacks, StoredEvent } from "../types.js";
import type { Event } from "../../../core/types.js";
import { TurnAccumulator } from "../lib/turn-accumulator.js";

/** Adapt a live bus event into StoredEvent shape. */
function toStoredEvent(event: Event, emitterId?: string): StoredEvent {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const stored: StoredEvent = {
    type: event.type,
    ts: event.ts ?? Date.now(),
    source: event.source,
    to: event.to,
    emitterId,
    payload: p,
  };
  if (event.handoff) stored.handoff = event.handoff;
  return stored;
}

export interface EventDispatch {
  appendStreamText: (text: string) => void;
  appendThinkingText: (text: string) => void;
  pushMessage: (msg: import("../types.js").RendererMessage) => void;
  updateMessage: (callId: string, msg: import("../types.js").RendererMessage) => void;
  commitTurn: (turn: import("../types.js").CompletedTurn) => void;
  setSessionLabel: (session: string) => void;
  setContextPct: (pct: number) => void;
  setIsThinking: (v: boolean) => void;
  resetStreaming: () => void;
}

export function useEventSubscription(
  callbacks: RendererCallbacks,
  dispatch: EventDispatch,
  activeAgentRef: { readonly current: string },
  activeAgent: string,
): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const d = () => dispatchRef.current;

    const acc = new TurnAccumulator({
      onTurn:          (turn) => d().commitTurn(turn),
      onMessage:       (msg)  => d().pushMessage(msg),
      onUpdateMessage: (id, m) => d().updateMessage(id, m),
      onStreamText:    (t)    => d().appendStreamText(t),
      onThinkingText:  (t)    => d().appendThinkingText(t),
      onResetStreaming: ()    => d().resetStreaming(),
      onMeta: (m) => {
        if (m.session) d().setSessionLabel(m.session);
        if (m.contextPct !== undefined) d().setContextPct(m.contextPct);
        if (m.thinking !== undefined) d().setIsThinking(m.thinking);
      },
    }, activeAgent);

    const unsubscribe = callbacksRef.current.observeEvents((event, emitterId) => {
      const ev = event as Event;
      const isLifecycle = ev.type === "instance_restarted";
      if (!isLifecycle) {
        const viewer = activeAgentRef.current;
        if (viewer && emitterId !== viewer && ev.to !== viewer) return;
      }
      acc.feed(toStoredEvent(ev, emitterId));
    });
    return unsubscribe;
  }, [activeAgent]);
}
