import { useEffect, useState, useCallback, useRef } from "react";
import type { StoredEvent } from "@/lib/event-engine/types";
import type { WsEventHandler } from "@/lib/ws";

interface UseEventStreamOptions {
  instanceId: string;
  agentId?: string;
  subscribe: (handler: WsEventHandler) => () => void;
}

export function useEventStream({ instanceId, agentId, subscribe }: UseEventStreamOptions) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const filterRef = useRef({ instanceId, agentId });
  filterRef.current = { instanceId, agentId };

  useEffect(() => {
    // emitterId is a frame-level sibling (see ws.ts); merge into event for storage.
    const unsub = subscribe((event, evtInstanceId, emitterId) => {
      const f = filterRef.current;
      if (evtInstanceId !== f.instanceId) return;
      if (f.agentId && emitterId !== f.agentId && event.to !== f.agentId) return;
      setEvents(prev => [...prev, { ...event, emitterId } as StoredEvent]);
    });
    return unsub;
  }, [subscribe]);

  const reset = useCallback(() => setEvents([]), []);

  return { events, reset };
}
