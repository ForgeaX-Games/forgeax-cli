import { useRef, useEffect, useState, useCallback } from "react";
import { WsClient, type WsEventHandler } from "@/lib/ws";

export function useWebSocket(token?: string) {
  const clientRef = useRef<WsClient | null>(null);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Set<WsEventHandler>>(new Set());

  useEffect(() => {
    const client = new WsClient({
      token,
      onEvent: (event, instanceId, emitterId) => {
        for (const h of handlersRef.current) h(event, instanceId, emitterId);
      },
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });
    client.connect();
    clientRef.current = client;
    return () => { client.disconnect(); clientRef.current = null; };
  }, [token]);

  const subscribe = useCallback((handler: WsEventHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  return { connected, subscribe, client: clientRef };
}
