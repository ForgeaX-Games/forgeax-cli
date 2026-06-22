// @desc SessionRegistry — Instance-level Map<sessionId, SessionRuntime>.
//
// One per Instance. Provides CRUD for chat-level Sessions:
//   create / get / list / dispose
//
// P1 (this revision): registry can hold multiple sessions in principle,
// but the Instance bootstrap only ever creates ONE "default" session so
// the legacy code paths keep working. Multi-session HTTP/UI plumbing
// arrives in P3.
//
// Each session gets its own SessionRuntime, and a fresh Scheduler is
// created inside it. In P1 there is at most one Scheduler per Instance,
// so the legacy `getInstanceScheduler()` global keeps pointing at it.
// P2 will let the registry hold N runtimes with N independent EventBuses
// and ledger namespaces.

import { Scheduler, setInstanceScheduler } from "./scheduler.js";
import type { Logger } from "./logger.js";
import { SessionRuntime, type SessionRuntimeAPI, type SessionRuntimeMeta } from "./session-runtime.js";

export interface CreateSessionOptions {
  /** AgentKind id for the root main agent (e.g. "admin"). Phase 2.3+ */
  rootKind?: string;
  /** Optional human-readable title (UI uses this on tab strip). */
  title?: string;
  /** Optional explicit id — caller-owned uuid. If omitted, registry mints one. */
  sessionId?: string;
}

export interface SessionRegistryAPI {
  create(opts?: CreateSessionOptions): Promise<SessionRuntimeAPI>;
  get(sessionId: string): SessionRuntimeAPI | null;
  list(): SessionRuntimeMeta[];
  dispose(sessionId: string, opts?: { archive?: boolean }): Promise<void>;
  /** Subscribe to events from every SessionRuntime (existing + future ones
   *  created after this call). Handler is invoked with the originating
   *  sessionId so subscribers can route or filter. Returns an unsubscribe fn. */
  observeAll(
    handler: (sessionId: string, event: import("./types.js").Event, emitterId?: string) => void,
  ): () => void;
}

/** Special sentinel for the P1 single-session fallback. P3 replaces this
 *  with real per-tab session ids minted by the UI. */
export const DEFAULT_SESSION_ID = "default" as const;

type AllObserver = (
  sessionId: string,
  event: import("./types.js").Event,
  emitterId?: string,
) => void;

export class SessionRegistry implements SessionRegistryAPI {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly logger: Logger;
  /** Pending subscribers that need to be hooked onto every SessionRuntime,
   *  including those created after the subscription itself. */
  private readonly allObservers = new Set<AllObserver>();
  /** sessionId → per-session unsub fn for each allObserver. Lets us unwind
   *  cleanly when a session is disposed or an allObserver is removed. */
  private readonly perSessionUnsubs = new Map<AllObserver, Map<string, () => void>>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async create(opts: CreateSessionOptions = {}): Promise<SessionRuntimeAPI> {
    const sid = opts.sessionId ?? `sid_${Date.now()}`;
    if (this.sessions.has(sid)) {
      throw new Error(`SessionRegistry: session "${sid}" already exists`);
    }

    // Each SessionRuntime gets its own fresh Scheduler — per-session
    // EventBus / AgentTree / TeamBoard / agent map. Real isolation kicks
    // in here: A-side publish never reaches B-side observers.
    const scheduler = new Scheduler(this.logger);

    const meta: SessionRuntimeMeta = {
      id: sid,
      rootAgentId: null,
      rootKind: opts.rootKind ?? null,
      title: opts.title ?? null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "active",
    };
    const runtime = new SessionRuntime(meta, scheduler);
    scheduler.sessionRuntime = runtime;

    // Legacy global pointer: kept only for capabilities that still call
    // getInstanceScheduler() (subagent / agent_manage). Reflects the most
    // recently created session — they should migrate to
    // `ctx.session.scheduler` in P4 so the pointer can be deleted.
    setInstanceScheduler(scheduler);

    this.sessions.set(sid, runtime);

    // Start the new session's Scheduler so its agent tree (root + subs from
    // team manifest) actually comes up. Without this the session has an
    // EventBus but no agents listening — emit user_input lands and nobody
    // responds. The legacy bootstrap path explicitly called sched.start()
    // from instance.start(); now every freshly-minted SessionRuntime takes
    // care of itself so HTTP /sessions create alone is enough to receive
    // turns.
    //
    // P1 invariant relaxation: only do this for non-default sessions. The
    // default session is still started via Instance.start() so the existing
    // `inst.start()` callsites keep producing the same bootstrap order
    // (provision → start → ready) the supervisor expects.
    if (sid !== "default") {
      try {
        await scheduler.start();
      } catch (e) {
        // If start fails (missing team manifest, agent template error, ...),
        // unwind so the registry doesn't keep a half-spawned runtime around.
        this.sessions.delete(sid);
        await runtime.dispose().catch(() => {});
        throw e;
      }
    }

    // Wire up every existing allObserver to this new session so they keep
    // hearing events from sessions that didn't exist when they subscribed.
    for (const obs of this.allObservers) {
      const unsub = runtime.observe((event, emitterId) => obs(sid, event, emitterId));
      let map = this.perSessionUnsubs.get(obs);
      if (!map) { map = new Map(); this.perSessionUnsubs.set(obs, map); }
      map.set(sid, unsub);
    }

    return runtime;
  }

  observeAll(handler: AllObserver): () => void {
    this.allObservers.add(handler);
    const perSession = new Map<string, () => void>();
    this.perSessionUnsubs.set(handler, perSession);
    // Hook onto every currently-existing session.
    for (const [sid, runtime] of this.sessions) {
      perSession.set(sid, runtime.observe((event, emitterId) => handler(sid, event, emitterId)));
    }
    return () => {
      for (const unsub of perSession.values()) {
        try { unsub(); } catch { /* ignore */ }
      }
      this.perSessionUnsubs.delete(handler);
      this.allObservers.delete(handler);
    };
  }

  get(sessionId: string): SessionRuntimeAPI | null {
    return this.sessions.get(sessionId) ?? null;
  }

  list(): SessionRuntimeMeta[] {
    return [...this.sessions.values()].map((s) => s.meta);
  }

  /** Returns the default session if present, else null. P1 single-session
   *  fallback uses this to route legacy `inst.emit` / `inst.observeEvents`. */
  getDefault(): SessionRuntime | null {
    return this.sessions.get(DEFAULT_SESSION_ID) ?? null;
  }

  /** Convenience for legacy callers that don't track sessionId. P1 only. */
  getAnyOrDefault(): SessionRuntime | null {
    const def = this.sessions.get(DEFAULT_SESSION_ID);
    if (def) return def;
    const first = this.sessions.values().next();
    return first.done ? null : first.value;
  }

  async dispose(sessionId: string, _opts?: { archive?: boolean }): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    // Unwind allObserver wiring before tearing down the runtime — keeps the
    // per-observer Map<sid, unsub> consistent with this.sessions.
    for (const [obs, map] of this.perSessionUnsubs) {
      const unsub = map.get(sessionId);
      if (unsub) { try { unsub(); } catch { /* ignore */ } map.delete(sessionId); }
      // obs reference kept so future sessions still hook to it
      void obs;
    }
    await runtime.dispose();
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    const tasks = [...this.sessions.values()].map((r) => r.dispose().catch(() => {}));
    await Promise.all(tasks);
    this.sessions.clear();
  }
}
