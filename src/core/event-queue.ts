/** Per-agent inbox queue —— 每个 agent 一份，由 EventBus 路由进来。
 *
 *  和 ref agenteam 99 行 1:1 对齐，handoff 五态：
 *    silent     — 入队但不唤醒 waiter（statictick / 后台事件）
 *    passive    — 仅在已有 waiter 时投递，否则丢弃（极轻量提示）
 *    turn       — 默认；入队 + 唤醒 waiter
 *    innerLoop  — 同 turn 但语义上属于 agent 内部循环
 *    steer      — 高优中断；入队 + 触发 onSteer 监听器立即打断 LLM stream
 *
 *  排序：priority asc + ts asc（priority 0 最优先）。
 *  容量上限：MAX_EVENTS=50，溢出时 FIFO 丢老的（避免事件爆栈）。 */

import type { Event, EventHandoff, EventQueueAPI } from "./types";

const MAX_EVENTS = 50;

const eventComparator = (a: Event, b: Event): number =>
  (a.priority ?? 1) - (b.priority ?? 1) || a.ts - b.ts;

function resolveEventHandoff(event: Event): EventHandoff {
  return event.handoff ?? "turn";
}

export class EventQueue implements EventQueueAPI {
  private queue: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;
  private steerListeners = new Set<() => void>();

  push(event: Event): void {
    const handoff = resolveEventHandoff(event);
    if (handoff === "passive") {
      // passive 仅在 waiter 已挂起时才有意义 —— 不入队驻留。
      if (this.waiter) {
        this.queue.push(event);
        const resolve = this.waiter;
        this.waiter = null;
        resolve(event);
      }
      return;
    }
    this.queue.push(event);
    if (this.queue.length > MAX_EVENTS) {
      this.queue.shift();
    }
    if (handoff === "steer") {
      for (const cb of this.steerListeners) {
        try { cb(); } catch { /* listener error, swallow */ }
      }
    }
    if (handoff !== "silent" && this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(event);
    }
  }

  /** 等下一个非 silent 事件；signal abort 时 reject。 */
  waitForEvent(signal?: AbortSignal): Promise<Event> {
    const trigger = this.queue.find((e) => resolveEventHandoff(e) !== "silent");
    if (trigger) {
      return Promise.resolve(trigger);
    }
    return new Promise<Event>((resolve, reject) => {
      // The abort listener MUST be removed on BOTH settle paths. The agent
      // main loop reuses one long-lived turnSignal across every turn (see
      // conscious-agent runMain), so the previous {once:true}-only cleanup
      // leaked one listener per turn on the normal (event-woken) path —
      // accumulating into hundreds/thousands + MaxListeners warnings over a
      // long session. try/finally-style symmetric removal closes both paths.
      const onAbort = () => {
        this.waiter = null;
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const settleResolve = (event: Event) => {
        cleanup();
        resolve(event);
      };
      if (signal?.aborted) {
        this.waiter = null;
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      this.waiter = settleResolve;
      signal?.addEventListener("abort", onAbort);
    });
  }

  drain(filter?: (event: Event) => boolean): Event[] {
    if (this.queue.length === 0) return [];
    if (!filter) {
      const batch = [...this.queue];
      this.queue.length = 0;
      batch.sort(eventComparator);
      return batch;
    }

    const batch: Event[] = [];
    const remaining: Event[] = [];
    for (const event of this.queue) {
      if (filter(event)) batch.push(event);
      else remaining.push(event);
    }
    this.queue = remaining;
    batch.sort(eventComparator);
    return batch;
  }

  pending(): number {
    return this.queue.length;
  }

  get isWaiting(): boolean {
    return this.waiter !== null;
  }

  hasHandoff(handoff: EventHandoff): boolean {
    return this.queue.some((e) => resolveEventHandoff(e) === handoff);
  }

  onSteer(cb: () => void): { dispose(): void } {
    this.steerListeners.add(cb);
    return {
      dispose: () => { this.steerListeners.delete(cb); },
    };
  }
}
