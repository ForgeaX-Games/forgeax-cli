/** Per-session 事件总线 —— observer 广播 + handoff 队列路由。
 *
 *  比 agenteam ref 88 行版本简化：
 *  - 砍 IPC 跨进程派发分支（forgeax 单进程，没 worker）
 *  - 砍 logger getConsoleLogger 依赖（logger 模块 C7 才进来；observer error 暂走 console.warn）
 *
 *  保留：
 *  - 5 种 handoff（silent / passive / turn / innerLoop / steer），由 EventQueue 解释
 *  - publish() 给 event 挂 block / isBlocked 通道（hook handler 可以短路后续 observer）
 *  - emit() = publish + route，broadcast (`to: "*"`) 自动排除 emitter 自身
 *  - emitToSelf() / hook() 是 BaseAgent.boundEventBus 提供的语义包装，raw bus 不实现
 *
 *  Session.dispose 时由 caller 遍历 dispose 函数清 observers；本类不持有定时器 / FS watcher。 */

import type {
  Event,
  EventQueueAPI,
} from "./types";

type ObserverHandler = (event: Event, emitterId?: string) => void;

/** EventBus 类只暴露「raw」事件总线（publish/emit/observe/observeAgent + register/unregister）。
 *  `emitToSelf` / `hook` 这两个 agent-scope 语义糖由 BaseAgent 的 boundEventBus
 *  包 me 后提供 —— raw bus 不知道 emitter 是谁，也不该构造 agent-scope source。 */
export class EventBus {
  private observers = new Set<ObserverHandler>();
  private agentQueueMap = new Map<string, EventQueueAPI>();

  // ─── Observer registration ────────────────────────────────────────────

  observe(handler: ObserverHandler): () => void {
    this.observers.add(handler);
    return () => { this.observers.delete(handler); };
  }

  observeAgent(agentId: string, handler: (event: Event) => void): () => void {
    const filtered: ObserverHandler = (event, emitterId) => {
      if (emitterId === agentId) handler(event);
    };
    return this.observe(filtered);
  }

  // ─── Queue registration ───────────────────────────────────────────────

  register(agentId: string, queue: EventQueueAPI): void {
    this.agentQueueMap.set(agentId, queue);
  }

  unregister(agentId: string): void {
    this.agentQueueMap.delete(agentId);
  }

  // ─── publish — observers only, no queue routing ───────────────────────

  publish(event: Event, emitterId?: string): void {
    let blocked = false;
    event.block = (reason?: string) => { blocked = true; event.blockReason = reason; };
    event.isBlocked = () => blocked;

    for (const h of this.observers) {
      try {
        h(event, emitterId);
      } catch (err) {
        // 不能用 console.error —— logger bridge 落地后会形成自循环；用 stderr.write 直写。
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[event-bus] observer error on "${event.type}": ${msg}\n`);
      }
    }
  }

  // ─── emit — publish + route ───────────────────────────────────────────
  //
  //  event.to 解析：
  //    "*"      → broadcast，给除 emitter 之外的所有 agent 队列推送
  //    agentId  → 直投目标 agent 队列
  //  observer 总是触发（与 publish 一致）；isBlocked 短路后续路由。

  emit(event: Event, emitterId?: string): void {
    this.publish(event, emitterId);
    if (event.isBlocked?.()) return;
    if (event.to) {
      this.route(event, emitterId);
    }
  }

  // NOTE: raw EventBus does NOT expose `hook(type, payload)` — it would be over-
  // implementation. `hook` is BaseAgent.boundEventBus 的 convenience wrapper
  // that publishes with `source: agent:<id>`; raw bus 保持 dumb，跟 ref 一致。

  // ─── Private: queue routing ───────────────────────────────────────────

  private route(event: Event, emitterId?: string): void {
    if (event.to === "*") {
      for (const [id, queue] of this.agentQueueMap) {
        if (id !== emitterId) queue.push(event);
      }
    } else {
      const queue = this.agentQueueMap.get(event.to as string);
      if (queue) queue.push(event);
    }
  }
}
