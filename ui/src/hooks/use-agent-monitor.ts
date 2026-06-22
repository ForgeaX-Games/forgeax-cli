import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { CompletedTurn, StoredEvent } from "@/lib/event-engine/types";
import { TurnAccumulator } from "@/lib/event-engine/turn-accumulator";
import { replayEvents } from "@/lib/event-engine/event-replay";
import type { WsEventHandler } from "@/lib/ws";

interface UseAgentMonitorOptions {
  instanceId: string;
  agentId: string;
  subscribe: (handler: WsEventHandler) => () => void;
}

export function useAgentMonitor({ instanceId, agentId, subscribe }: UseAgentMonitorOptions) {
  const [turns, setTurns] = useState<CompletedTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [streamText, setStreamText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const accRef = useRef<TurnAccumulator | null>(null);

  useEffect(() => {
    setLoading(true);
    setTurns([]);
    setStreamText("");
    setThinkingText("");

    const acc = new TurnAccumulator({
      onTurn: (turn) => setTurns(prev => [...prev, turn]),
      onStreamText: (chunk) => setStreamText(prev => prev + chunk),
      onThinkingText: (chunk) => setThinkingText(prev => prev + chunk),
      onResetStreaming: () => { setStreamText(""); setThinkingText(""); },
      onMeta: (meta) => {
        if (meta.thinking !== undefined) setIsThinking(meta.thinking);
      },
    }, agentId);
    accRef.current = acc;

    api.cmdQuery<StoredEvent[]>(instanceId, "fetch_session_events_jsonl", [agentId])
      .then((events) => {
        const initial = replayEvents(events, agentId);
        setTurns(initial);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // emitterId is a frame-level sibling (see ws.ts); merge into event for downstream.
    const unsub = subscribe((event, evtInstanceId, emitterId) => {
      if (evtInstanceId !== instanceId) return;
      if (emitterId !== agentId && event.to !== agentId) return;
      acc.feed({ ...event, emitterId } as StoredEvent);
    });

    return () => {
      unsub();
      accRef.current = null;
    };
  }, [instanceId, agentId, subscribe]);

  return { turns, loading, streamText, thinkingText, isThinking };
}
