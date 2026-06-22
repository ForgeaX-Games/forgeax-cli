/**
 * WebSocket client for Gateway real-time events.
 * Auth + auto-reconnect with exponential backoff + typed event dispatch.
 * `emitterId` is a frame-level sibling field, NOT inside `event` — handlers
 * receive it as the third arg.
 */

import type { StoredEvent } from "./event-engine/types";

export type WsFrame =
  | { type: "auth"; token: string }
  | { type: "auth_ok" }
  | { type: "event"; instanceId: string; event: StoredEvent; emitterId?: string; seq: number }
  | { type: "error"; message: string }
  | { type: "ping" }
  | { type: "pong" };

export type WsEventHandler = (event: StoredEvent, instanceId: string, emitterId?: string) => void;

interface WsClientOptions {
  url?: string;
  token?: string;
  onEvent?: WsEventHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: string) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const PING_INTERVAL = 25000;

export class WsClient {
  private ws: WebSocket | null = null;
  private options: WsClientOptions;
  private reconnectDelay = BASE_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.closed = false;
    const wsUrl = this.options.url ?? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      this.reconnectDelay = BASE_DELAY;
      if (this.options.token) {
        ws.send(JSON.stringify({ type: "auth", token: this.options.token }));
      }
      this.startPing();
    };

    ws.onmessage = (evt) => {
      try {
        const frame = JSON.parse(evt.data as string);
        if (frame.type === "auth_ok") {
          this.options.onConnect?.();
        } else if (frame.type === "event") {
          this.options.onEvent?.(frame.event, frame.instanceId, frame.emitterId);
        } else if (frame.type === "error") {
          this.options.onError?.(frame.message);
        }
      } catch {}
    };

    ws.onclose = () => {
      this.stopPing();
      this.options.onDisconnect?.();
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };

    this.ws = ws;
  }

  disconnect(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
