import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { getSessionManager } from './core/session-manager';
import type { Event } from './core/types';

export interface WsClientData {
  id: string;
  /** Optional session subscription —— 升级时通过 ?sid= 携带。 */
  sid?: string;
  dispose?: () => void;
  /**
   * Reverse-proxy mode —— 升级时设置 `proxy.url` 后，由 main.ts 的桥接
   * 处理把这条连接转发到上游 WS（目前 wb-scene backend :9557 的 /ws/*），
   * 不进入 hub/session 的 baseHandler 逻辑。
   */
  proxy?: { url: string; protocol?: string };
}

export class WsHub {
  private clients = new Set<ServerWebSocket<WsClientData>>();

  add(ws: ServerWebSocket<WsClientData>): void {
    this.clients.add(ws);
  }

  remove(ws: ServerWebSocket<WsClientData>): void {
    this.clients.delete(ws);
  }

  size(): number {
    return this.clients.size;
  }

  broadcast(event: object): void {
    const json = JSON.stringify(event);
    for (const c of this.clients) {
      try { c.send(json); } catch { /* client gone; close handler removes */ }
    }
  }

  send(ws: ServerWebSocket<WsClientData>, event: object): void {
    try { ws.send(JSON.stringify(event)); } catch { /* ignore */ }
  }
}

// 升级阶段从 URL 拿 ?sid= —— main.ts 在 fetch handler 里塞进 ws.data.sid。
// open() 里拿到 sid 后做 sm.open 并直接订阅 session.eventBus —— 不再走任何 attach 计数
// 包装（Session 不该背 client ref-count，谁连着哪个 sid 由 WsHub 自己按 ws.data.sid 查）。
// 其它仍然通过 hub.broadcast 收 fs-watcher。
export function createWsHandler(hub: WsHub): WebSocketHandler<WsClientData> {
  return {
    async open(ws) {
      hub.add(ws);
      hub.send(ws, { type: 'hello', id: ws.data.id, sid: ws.data.sid });

      const sid = ws.data.sid;
      if (!sid) return;

      try {
        const session = await getSessionManager().open(sid);
        session.scheduler.start();
        const dispose = session.eventBus.observe((event: Event, emitterId?: string) => {
          hub.send(ws, { type: 'session-event', sid, emitterId, event });
        });
        ws.data.dispose = dispose;
      } catch (err: any) {
        hub.send(ws, { type: 'error', message: `attach session ${sid} failed: ${err?.message ?? err}` });
      }
    },
    message(ws) {
      hub.send(ws, { type: 'error', message: 'inbound WS messages not supported; POST /api/sessions/:sid/messages' });
    },
    close(ws) {
      try { ws.data.dispose?.(); } catch { /* ignore */ }
      hub.remove(ws);
    },
  };
}
