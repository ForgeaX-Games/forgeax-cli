/** @desc WebSocket handler — real-time EventBus stream for external clients */

import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import type { GatewayContext } from "../types.js";
import type { Event } from "../../core/types.js";

export interface WsHandlerOptions {
  server: Server;
  ctx: GatewayContext;
  token?: string;
}

const AUTH_TIMEOUT_MS = 10_000;
const SLOW_CONSUMER_BYTES = 1024 * 1024;

const authenticated = new WeakMap<WebSocket, boolean>();

function isAuthed(ws: WebSocket): boolean {
  return authenticated.get(ws) === true;
}

/**
 * WebSocket handler for the Gateway. Streams every instance event to every
 * authed client; subscribers (ink-renderer / wechat / 3rd-party UIs) own their
 * own ws lifecycle and filter locally by instanceId. The Gateway no longer
 * tracks "channels" as a first-class concept — see docs/gateway-protocol.md.
 */
export class WsHandler {
  private wss: WebSocketServer;
  private ctx: GatewayContext;
  private token: string | undefined;
  private seq = 0;
  private unsubs: (() => void)[] = [];

  constructor(opts: WsHandlerOptions) {
    this.ctx = opts.ctx;
    this.token = opts.token;
    this.wss = new WebSocketServer({ server: opts.server, path: "/ws" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.subscribeAllInstances();
  }

  private onConnection(ws: WebSocket): void {
    const skipAuth = !this.token;
    if (skipAuth) {
      authenticated.set(ws, true);
      send(ws, { type: "auth_ok" });
    }

    const authTimer = skipAuth ? null : setTimeout(() => {
      if (!isAuthed(ws)) {
        send(ws, { type: "error", message: "Auth timeout" });
        ws.close(4001, "Auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      switch (frame.type) {
        case "auth":
          this.handleAuth(ws, frame, authTimer);
          break;
        case "emit":
          this.handleEmit(ws, frame);
          break;
        case "list_commands":
          void this.handleListCommands(ws, frame);
          break;
        case "command_query":
          void this.handleCommandCall("query", ws, frame);
          break;
        case "command_execute":
          void this.handleCommandCall("execute", ws, frame);
          break;
        case "ping":
          send(ws, { type: "pong" });
          break;
        default:
          send(ws, { type: "error", message: `Unknown type: ${frame.type}` });
      }
    });

    ws.on("close", () => {
      if (authTimer) clearTimeout(authTimer);
      authenticated.delete(ws);
    });
  }

  private handleAuth(
    ws: WebSocket,
    frame: Record<string, unknown>,
    timer: ReturnType<typeof setTimeout> | null,
  ): void {
    if (isAuthed(ws)) {
      send(ws, { type: "error", message: "Already authenticated" });
      return;
    }
    if (this.token && frame.token !== this.token) {
      send(ws, { type: "error", message: "Invalid token" });
      ws.close(4003, "Invalid token");
      return;
    }
    authenticated.set(ws, true);
    if (timer) clearTimeout(timer);
    send(ws, { type: "auth_ok" });
  }

  private handleEmit(ws: WebSocket, frame: Record<string, unknown>): void {
    if (!isAuthed(ws)) {
      send(ws, { type: "error", message: "Not authenticated" });
      return;
    }
    const event = frame.event as Event | undefined;
    if (!event || !event.type) {
      send(ws, { type: "error", message: "Missing event or event.type" });
      return;
    }
    const instanceId = frame.instanceId as string | undefined;
    try {
      const inst = instanceId
        ? this.ctx.getInstance(instanceId)
        : this.ctx.getDefaultInstance();
      if (!inst) {
        send(ws, { type: "error", message: `Instance "${instanceId}" not found` });
        return;
      }
      inst.emit(event);
    } catch {
      send(ws, { type: "error", message: "No instance available" });
    }
  }

  // ── Command system handlers (Phase 1.1) ─────────────────────────────

  private async handleListCommands(
    ws: WebSocket,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (!isAuthed(ws)) return;
    const requestId = frame.requestId as string | undefined;
    if (!requestId) return;
    const instanceId = frame.instanceId as string | undefined;
    const requestingAgentId = frame.requestingAgentId as string | undefined;

    try {
      const inst = instanceId
        ? this.ctx.getInstance(instanceId)
        : this.ctx.getDefaultInstance();
      if (!inst) {
        send(ws, { type: "command_result", requestId, result: { ok: false, error: `Instance "${instanceId}" not found` } });
        return;
      }
      const data = await inst.listCommands(requestingAgentId);
      send(ws, { type: "command_result", requestId, result: { ok: true, data: data.commands } });
    } catch (err) {
      send(ws, { type: "command_result", requestId, result: { ok: false, error: (err as Error)?.message ?? String(err) } });
    }
  }

  private async handleCommandCall(
    op: "query" | "execute",
    ws: WebSocket,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (!isAuthed(ws)) return;
    const requestId = frame.requestId as string | undefined;
    if (!requestId) return;

    const instanceId = frame.instanceId as string | undefined;
    const requestingAgentId = frame.requestingAgentId as string | undefined;
    const name = frame.name as string | undefined;
    // Runner contract: guarantee `string[]` so command modules own all parsing.
    const args = Array.isArray(frame.args) ? (frame.args as unknown[]).map(String) : [];

    if (!name) {
      send(ws, { type: "command_result", requestId, result: { ok: false, error: "Missing command name" } });
      return;
    }
    try {
      const inst = instanceId
        ? this.ctx.getInstance(instanceId)
        : this.ctx.getDefaultInstance();
      if (!inst) {
        send(ws, { type: "command_result", requestId, result: { ok: false, error: `Instance "${instanceId}" not found` } });
        return;
      }
      const result = op === "query"
        ? await inst.commandQuery(name, args, { requestingAgentId })
        : await inst.commandExecute(name, args, { requestingAgentId });
      send(ws, { type: "command_result", requestId, result });
    } catch (err) {
      send(ws, { type: "command_result", requestId, result: { ok: false, error: (err as Error)?.message ?? String(err) } });
    }
  }

  private subscribeAllInstances(): void {
    for (const { id } of this.ctx.listInstances()) {
      const inst = this.ctx.getInstance(id);
      if (!inst) continue;
      // observeAll covers every SessionRuntime — existing + future. Each frame
      // carries its source sessionId so clients can route per-tab.
      const unsub = inst.sessions.observeAll((sessionId, event, emitterId) => {
        this.broadcast(id, sessionId, event, emitterId);
      });
      this.unsubs.push(unsub);
    }
  }

  /** Subscribe to a newly added instance (call after addInstance). */
  subscribeInstance(instanceId: string): void {
    const inst = this.ctx.getInstance(instanceId);
    if (!inst) return;
    const unsub = inst.sessions.observeAll((sessionId, event, emitterId) => {
      this.broadcast(instanceId, sessionId, event, emitterId);
    });
    this.unsubs.push(unsub);
  }

  /**
   * Broadcast an event frame to every authed client. There is no server-side
   * instanceId filter — each subscriber decides locally whether to consume
   * the event. Slow consumers (bufferedAmount > 1 MiB) are skipped to prevent
   * head-of-line blocking.
   *
   * `sessionId` lets clients route per-tab in a multi-session world. Frames
   * always carry it now (previously absent — every legacy client saw the
   * union of all sessions).
   */
  private broadcast(instanceId: string, sessionId: string, event: Event, emitterId?: string): void {
    const frame = JSON.stringify({ type: "event", instanceId, sessionId, event, emitterId, seq: ++this.seq });
    for (const ws of this.wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!isAuthed(ws)) continue;
      if (ws.bufferedAmount > SLOW_CONSUMER_BYTES) continue;
      ws.send(frame);
    }
  }

  close(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    for (const ws of this.wss.clients) {
      ws.close(1001, "Server shutting down");
    }
    this.wss.close();
  }
}

function send(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function parseFrame(raw: RawData): Record<string, unknown> | null {
  try {
    const str = typeof raw === "string" ? raw : raw.toString("utf-8");
    const obj = JSON.parse(str);
    return obj && typeof obj === "object" && typeof obj.type === "string" ? obj : null;
  } catch {
    return null;
  }
}
