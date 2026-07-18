import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { getSessionManager } from './core/session-manager';
import type { Session } from './core/session';
import type { Event } from './core/types';

export interface WsClientData {
  id: string;
  /** Optional session subscription —— 升级时通过 ?sid= 携带。 */
  sid?: string;
  /** 断线续传(多 tab 同步 §3.3)—— 升级时通过 ?since=<seq>&sgen= 携带。 */
  since?: number;
  sgen?: string;
  /**
   * Reverse-proxy mode —— 升级时设置 `proxy.url` 后，由 main.ts 的桥接
   * 处理把这条连接转发到上游 WS（目前 wb-scene backend :9557 的 /ws/*），
   * 不进入 hub/session 的 baseHandler 逻辑。
   */
  proxy?: { url: string; protocol?: string };
}

// ring buffer 只为覆盖秒级网络抖动/后台 tab 冻结;超窗走全量恢复(resume-gap)。
const RING_MAX_FRAMES = 512;
const RING_MAX_BYTES = 256 * 1024;

interface SessionSub {
  conns: Set<ServerWebSocket<WsClientData>>;
  ring: Array<{ seq: number; json: string }>;
  ringBytes: number;
  unsub: () => void;
}

export class WsHub {
  private clients = new Set<ServerWebSocket<WsClientData>>();
  /** 每 sid 一个共享 eventBus observer:序列化一次 → ring → 对 conns 循环 send
   *  (多 tab 同步 §4.1;替代旧的 per-connection observer + per-connection stringify)。 */
  private subs = new Map<string, SessionSub>();

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

  attachSession(ws: ServerWebSocket<WsClientData>, session: Session): void {
    const sid = session.sid;
    let sub = this.subs.get(sid);
    if (!sub) {
      const created: SessionSub = { conns: new Set(), ring: [], ringBytes: 0, unsub: () => {} };
      created.unsub = session.eventBus.observe((event: Event, emitterId?: string) => {
        const json = JSON.stringify({ type: 'session-event', sid, emitterId, event });
        if (typeof event.seq === 'number') {
          created.ring.push({ seq: event.seq, json });
          created.ringBytes += json.length;
          while (created.ring.length > RING_MAX_FRAMES || created.ringBytes > RING_MAX_BYTES) {
            const dropped = created.ring.shift();
            if (!dropped) break;
            created.ringBytes -= dropped.json.length;
          }
        }
        for (const c of created.conns) {
          try { c.send(json); } catch { /* client gone; close handler removes */ }
        }
      });
      this.subs.set(sid, created);
      sub = created;
    }
    sub.conns.add(ws);
  }

  detachSession(ws: ServerWebSocket<WsClientData>): void {
    const sid = ws.data.sid;
    if (!sid) return;
    const sub = this.subs.get(sid);
    if (!sub) return;
    sub.conns.delete(ws);
    if (sub.conns.size === 0) {
      sub.unsub();
      this.subs.delete(sid);
    }
  }

  /** 断线续传:`(sgen, since)` 在 ring 窗口内则逐帧补发并返回 true;
   *  否则返回 false,caller 发 resume-gap 让客户端走全量恢复。 */
  resume(ws: ServerWebSocket<WsClientData>, session: Session, since: number): boolean {
    if (ws.data.sgen !== session.eventBus.sgen) return false;
    const sub = this.subs.get(session.sid);
    if (!sub) return false;
    if (sub.ring.length === 0) return session.eventBus.seq <= since; // 无缺口 = 直接接直播
    if (sub.ring[0].seq > since + 1) return false;                   // 窗口被逐出
    for (const frame of sub.ring) {
      if (frame.seq > since) {
        try { ws.send(frame.json); } catch { /* ignore */ }
      }
    }
    return true;
  }
}

// 升级阶段从 URL 拿 ?sid=&since=&sgen= —— main.ts 在 fetch handler 里塞进 ws.data。
// open() 里拿到 sid 后做 sm.open 并把连接挂到 hub 的 per-sid 共享订阅上;
// 随后按多 tab 同步协议发 hello(sgen+seq 水位)→ resume 补发或 turn-snapshot。
// 其它仍然通过 hub.broadcast 收 fs-watcher。
export function createWsHandler(hub: WsHub): WebSocketHandler<WsClientData> {
  return {
    async open(ws) {
      hub.add(ws);

      const sid = ws.data.sid;
      if (!sid) {
        hub.send(ws, { type: 'hello', id: ws.data.id });
        return;
      }

      try {
        // 写时迁移(plan B PR2-compat)前移到 WS 连接时:打开老 session 的聊天连接即把它迁入
        // 当前项目 games/<bound-slug>/sessions/<sid>/,**在订阅 eventBus 之前**完成。否则若等到
        // 发消息时才迁移,prepareForWrite 的 close+reopen 会换掉 session 实例 + eventBus,本 WS
        // 仍盯着旧(已 dispose 的)eventBus → 实时回复推不到前端(看似卡死)。幂等;非老 session no-op。
        await getSessionManager().prepareForWrite(sid);
        const session = await getSessionManager().open(sid);
        session.scheduler.start();

        // open() 在上面两个 await 后才 resume:若 socket 在 await 期间已关闭,close()→
        // detachSession 早已跑过(此 sid 尚无 sub → no-op),此刻再 attach 会为一条死连接
        // 建 per-sid observer + ring,而它永远到不了 conns.size===0 → observer 永久泄漏。
        // 非 OPEN 就直接放弃(bun 单线程,过了此闸下面同步块不会再被 close 插队)。
        if (ws.readyState !== 1 /* OPEN */) return;

        // 以下同步串行(bun 单线程):挂订阅 → hello → 补发/快照。期间不可能有事件
        // 插队,快照原子性(§3.2)天然成立。
        hub.attachSession(ws, session);
        const bus = session.eventBus;
        hub.send(ws, { type: 'hello', id: ws.data.id, sid, sgen: bus.sgen, lastSeq: bus.seq });

        const since = ws.data.since;
        if (typeof since === 'number' && hub.resume(ws, session, since)) {
          return; // 窗口内补发完成,缺口内容已含 —— 不发快照
        }
        if (typeof since === 'number') {
          hub.send(ws, { type: 'resume-gap', sid, sgen: bus.sgen, from: since });
        }
        for (const snap of session.liveTurns.snapshots()) {
          hub.send(ws, {
            type: 'turn-snapshot',
            sid,
            emitterId: snap.emitterId,
            payload: { ...snap, seq: bus.seq, sgen: bus.sgen },
          });
        }
      } catch (err: any) {
        hub.send(ws, { type: 'error', message: `attach session ${sid} failed: ${err?.message ?? err}` });
      }
    },
    message(ws) {
      hub.send(ws, { type: 'error', message: 'inbound WS messages not supported; POST /api/sessions/:sid/messages' });
    },
    close(ws) {
      hub.detachSession(ws);
      hub.remove(ws);
    },
  };
}
