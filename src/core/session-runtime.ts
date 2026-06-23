// @desc SessionRuntime — runtime tree for ONE chat session.
//
// A SessionRuntime owns:
//   - 1 EventBus (session-scoped, NOT shared with other sessions; P2 turns
//     this from "shared by default" into "really isolated")
//   - 1 AgentTree (root + sub-agents, session-local in the target model;
//     P1 still shares with peers via the per-instance disk file — that
//     wiring is moved into the session in P2.x)
//   - 1 TeamBoard (per-session collaboration state in the target model;
//     same P1/P2 caveat as AgentTree)
//   - 1 Scheduler-loop (drives runMain() for every agent in the tree)
//   - 1 root main agent + N sub-agents
//   - The disk namespace `instances/<inst>/sessions/<sessionId>/` (P2)
//
// P1 (this revision): SessionRuntime is a thin wrapper around one
// Scheduler. The Instance creates exactly one SessionRuntime
// (id="default") so all legacy code paths that go through
// `getInstanceScheduler()` / `inst.emit` / `inst.observeEvents` keep
// working unchanged. Multi-session and real per-session isolation are
// wired up in P2 (EventBus/ledger isolation) and P3 (HTTP/UI plumbing).
//
// Strict invariants (enforced from P2 onward):
//   - exactly ONE root agent per SessionRuntime
//   - sub-agents are local to this session — dispose() shuts them all down
//   - EventBus is per-session: A-side publish never reaches B-side observers

import type { Event } from "./types.js";
import type { EventBus } from "./event-bus.js";
import type { Scheduler } from "./scheduler.js";

export interface SessionRuntimeMeta {
  readonly id: string;
  /** Root agent id within this session. P2+ enforces exactly one root. */
  rootAgentId: string | null;
  /** AgentKind id used to spawn the root (e.g. "admin"). */
  rootKind: string | null;
  /** Human-readable title (UI tab strip). */
  title: string | null;
  readonly createdAt: number;
  lastActivityAt: number;
  status: "active" | "hibernated" | "disposing" | "disposed";
}

export interface SessionRuntimeAPI {
  readonly meta: SessionRuntimeMeta;
  readonly eventBus: EventBus;
  /** Session-local Scheduler (loop engine + agent map). Exposed as an
   *  implementation surface for capabilities that need to spawn / shutdown
   *  agents inside this session (sub-agent launcher, agent_manage tools).
   *  Long-term it becomes a facade — for now it's the same Scheduler the
   *  legacy global pointer used to return. Use this instead of the global
   *  getInstanceScheduler(), which only ever returns one of the N sessions. */
  readonly scheduler: import("./scheduler.js").Scheduler;
  /** Publish an event to the session's bus. */
  emit(event: Event): void;
  /** Observe events on this session's bus. Returns an unsubscribe handle. */
  observe(handler: (event: Event, emitterId?: string) => void): () => void;
  /** Stop scheduler loop, shutdown agent tree, fsync ledgers, dispose watches. */
  dispose(): Promise<void>;
}

/**
 * P1 implementation: a SessionRuntime wraps one Scheduler. The Scheduler
 * is the canonical owner of EventBus / AgentTree / TeamBoard / agent map
 * — SessionRuntime delegates to it. Future phases will narrow the gap by
 * moving lifecycle responsibilities out of Scheduler and into SessionRuntime.
 */
export class SessionRuntime implements SessionRuntimeAPI {
  readonly meta: SessionRuntimeMeta;
  private readonly _scheduler: Scheduler;

  constructor(meta: SessionRuntimeMeta, scheduler: Scheduler) {
    this.meta = meta;
    this._scheduler = scheduler;
  }

  /** Internal accessor — Instance / SessionRegistry use this to drive lifecycle.
   *  Not exported through the public SessionRuntimeAPI. */
  get scheduler(): Scheduler {
    return this._scheduler;
  }

  get eventBus(): EventBus {
    return this._scheduler.eventBus;
  }

  emit(event: Event): void {
    this._scheduler.eventBus.emit(event);
    this.meta.lastActivityAt = Date.now();
  }

  observe(handler: (event: Event, emitterId?: string) => void): () => void {
    return this._scheduler.eventBus.observe(handler);
  }

  async dispose(): Promise<void> {
    if (this.meta.status === "disposing" || this.meta.status === "disposed") return;
    this.meta.status = "disposing";
    try {
      await this._scheduler.destroyRuntime();
    } finally {
      this.meta.status = "disposed";
    }
  }
}
