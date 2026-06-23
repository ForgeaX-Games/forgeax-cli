import type { Event, EventHandoff, EventQueueInterface } from "./types.js";

const MAX_EVENTS = 50;

const eventComparator = (a: Event, b: Event) =>
  (a.priority ?? 1) - (b.priority ?? 1) || a.ts - b.ts;

function resolveEventHandoff(event: Event): EventHandoff {
  return event.handoff ?? "turn";
}

export class EventQueue implements EventQueueInterface {
  private queue: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;
  private steerListeners = new Set<() => void>();

  push(event: Event): void {
    const handoff = resolveEventHandoff(event);
    if (handoff === "passive") {
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
        try { cb(); } catch { /* listener error */ }
      }
    }
    if (handoff !== "silent" && this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(event);
    }
  }

  waitForEvent(signal?: AbortSignal): Promise<Event> {
    const trigger = this.queue.find(e => resolveEventHandoff(e) !== "silent");
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
      if (filter(event)) {
        batch.push(event);
      } else {
        remaining.push(event);
      }
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
