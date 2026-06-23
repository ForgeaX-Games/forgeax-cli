/** @desc 统一事件总线 — 跨 agent 路由 + 生命周期 hook 广播 */

import type { Event, EventQueueInterface, SelfEvent } from "./types.js";
import { getConsoleLogger, getLogContext } from "./logger.js";

type ObserverHandler = (event: Event, emitterId?: string) => void;

export class EventBus {
  private observers = new Set<ObserverHandler>();
  private agentQueueMap = new Map<string, EventQueueInterface>();

  // ─── Observer registration ──────────────────────────────────────────────

  /** Register a global observer. Receives ALL events + emitterId. Returns unsubscribe fn. */
  observe(handler: ObserverHandler): () => void {
    this.observers.add(handler);
    return () => this.observers.delete(handler);
  }

  /** Observe only events from a specific emitter. Returns unsubscribe fn. */
  observeAgent(agentId: string, handler: (event: Event) => void): () => void {
    const filtered: ObserverHandler = (event, emitterId) => {
      if (emitterId === agentId) handler(event);
    };
    return this.observe(filtered);
  }

  // ─── Queue registration ─────────────────────────────────────────────────

  register(agentId: string, queue: EventQueueInterface): void {
    this.agentQueueMap.set(agentId, queue);
  }

  unregister(agentId: string): void {
    this.agentQueueMap.delete(agentId);
  }

  // ─── publish — observers only, no queue routing ─────────────────────────
  //
  //  For lifecycle hooks, announcements, and any event that doesn't need
  //  to enter an agent's processing queue.

  publish(event: Event, emitterId?: string): void {
    for (const h of this.observers) {
      try { h(event, emitterId); } catch (err) {
        // Use internal logger directly — console.warn would re-enter this bus via the logger bridge
        const logger = getConsoleLogger();
        const msg = `observer error on "${event.type}": ${err instanceof Error ? (err.stack ?? err.message) : err}`;
        if (logger) { const { agentId, turn } = getLogContext(); logger.warn(agentId, turn, msg); }
        else { process.stderr.write(`[event-bus] ${msg}\n`); }
      }
    }
  }

  // ─── emit — observers + queue routing via event.to ──────────────────────
  //
  //  event.to is required for routing:
  //    to === "*"        → broadcast: push to every agent queue except emitter
  //    to === agentId    → targeted:  push to that agent's queue
  //
  //  Observers always fire (same as publish).

  emit(event: Event, emitterId?: string): void {
    this.publish(event, emitterId);

    if (event.to) {
      this.route(event, emitterId);
    }
  }

  // ─── Private: queue routing ─────────────────────────────────────────────

  private route(event: Event, emitterId?: string): void {
    if (event.to === "*") {
      for (const [id, queue] of this.agentQueueMap) {
        if (id !== emitterId) queue.push(event);
      }
    } else {
      const queue = this.agentQueueMap.get(event.to!);
      if (queue) queue.push(event);
    }
  }
}
