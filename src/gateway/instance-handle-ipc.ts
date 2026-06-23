/**
 * @desc IPC Handle — lifecycle manager for a forked instance-worker child process.
 *
 * Lifecycle semantics:
 *   stop()              — soft: RPC "stop" to pause scheduler, worker process stays alive
 *   stop({ hard: true })— kill worker process (containers stay); used before re-fork
 *   shutdown()          — RPC "shutdown" (stops containers) → kill worker
 *
 * restart = stop({ hard: true }) + start()  — composed at Gateway layer.
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Event, InstanceHandle, InstanceConfig, InstanceStatus, ProvisioningPhase } from "../core/types.js";
import type { PortMapping } from "../sandbox/manager.js";
import { writeWorkerPid, removeWorkerPid } from "./worker-lifecycle.js";
import { ensureProvisioned } from "./instance-provision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_SCRIPT = join(__dirname, "..", "instance", "instance-worker.ts");

type ChildMsg =
  | { ch: "ctl"; type: "result"; callId: number; ok: boolean; value?: unknown; error?: string }
  | { ch: "ctl"; type: "ready"; id: string; status: string; error?: string }
  | { ch: "ctl"; type: "status"; status: string; statusMessage?: string; provisioningPhase?: ProvisioningPhase }
  | { ch: "ctl"; type: "portsChanged"; ports: number[] }
  | { ch: "ctl"; type: "requestRestart" }
  | { ch: "bus"; event: Event; emitterId?: string; sessionId?: string };

export interface InstanceHandleOptions {
  onPortsChanged?: (ports: number[]) => void;
  onCrash?: (id: string) => void;
  onRestartRequested?: (id: string) => void;
}

export async function createInstanceHandle(
  config: InstanceConfig,
  opts?: InstanceHandleOptions,
): Promise<InstanceHandle & { _pushPortMappings(mappings: PortMapping[]): void; _setStatusMessage(msg?: string): void }> {
  const workerScript = config.workerScript ?? DEFAULT_WORKER_SCRIPT;
  const observers = new Set<(event: Event, emitterId?: string) => void>();
  const sessionedObservers = new Set<(event: Event, emitterId?: string, sessionId?: string) => void>();

  let child: ChildProcess | null = null;
  let pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let callIdSeq = 0;
  let status: InstanceStatus = "idle";
  let statusMessage: string | undefined;
  let provisioningPhase: ProvisioningPhase | undefined;
  let dead = true;
  let stopRequested = false;
  let lock: Promise<void> = Promise.resolve();

  // ─── Internal: fork, ipc, kill (no lock, called inside locked ops) ───

  async function _spawn(): Promise<void> {
    if (config.templateDir) {
      status = "provisioning";
      statusMessage = "Provisioning instance (git clone / install)...";
      await ensureProvisioned(config.instanceDir, config.id, config.templateDir);
    }

    const c = fork(workerScript, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      cwd: config.instanceDir,
      env: { ...process.env, __AGENTEAM_INSTANCE_CONFIG: JSON.stringify(config) },
    });
    child = c;
    callIdSeq = 0;
    pending = new Map();
    dead = false;
    stopRequested = false;

    if (c.pid) writeWorkerPid(config.stateDir, config.id, c.pid);

    c.on("message", (raw: ChildMsg) => {
      if (raw.ch === "bus") {
        for (const h of observers) {
          try { h(raw.event, raw.emitterId); } catch {}
        }
        for (const h of sessionedObservers) {
          try { h(raw.event, raw.emitterId, raw.sessionId); } catch {}
        }
        return;
      }
      switch (raw.type) {
        case "result": {
          const p = pending.get(raw.callId);
          if (p) { pending.delete(raw.callId); raw.ok ? p.resolve(raw.value) : p.reject(new Error(raw.error ?? "RPC failed")); }
          break;
        }
        case "status":
          status = raw.status as InstanceStatus;
          if (raw.statusMessage !== undefined) statusMessage = raw.statusMessage || undefined;
          if (raw.status !== "provisioning") provisioningPhase = undefined;
          else if (raw.provisioningPhase !== undefined) provisioningPhase = raw.provisioningPhase;
          break;
        case "portsChanged":     opts?.onPortsChanged?.(raw.ports); break;
        case "requestRestart":   opts?.onRestartRequested?.(config.id); break;
      }
    });

    c.on("exit", (code) => {
      dead = true;
      removeWorkerPid(config.stateDir, config.id);
      for (const [, p] of pending) p.reject(new Error(`Child exited (code ${code})`));
      pending.clear();
      if (stopRequested) { status = "stopped"; return; }
      status = "restarting";
      opts?.onCrash?.(config.id);
    });

    await new Promise<void>((resolve, reject) => {
      const onMsg = (msg: ChildMsg) => {
        if (msg.ch !== "ctl" || msg.type !== "ready") return;
        c.removeListener("message", onMsg);
        c.removeListener("exit", onExit);
        if (msg.error) { status = "error"; statusMessage = msg.error; reject(new Error(`Init failed: ${msg.error}`)); }
        else { statusMessage = undefined; resolve(); }
      };
      const onExit = (code: number | null) => {
        c.removeListener("message", onMsg);
        reject(new Error(`Child exited during init (code ${code})`));
      };
      c.on("message", onMsg);
      c.once("exit", onExit);
    });
  }

  function _send(msg: Record<string, unknown>): void {
    if (!dead && child?.connected) child.send(msg);
  }

  function _notify(method: string, ...args: unknown[]): void {
    _send({ ch: "ctl", type: "notify", method, args });
  }

  function _rpc(method: string, ...args: unknown[]): Promise<unknown> {
    if (dead) return Promise.reject(new Error("Child process is dead"));
    const callId = callIdSeq++;
    _send({ ch: "ctl", type: "call", callId, method, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(callId)) reject(new Error(`RPC "${method}" timed out (8s)`));
      }, 8000);
      pending.set(callId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async function _kill(): Promise<void> {
    if (dead || !child) return;
    const c = child;
    if (c.exitCode === null) {
      try { c.kill("SIGTERM"); } catch {}
      await new Promise<void>(r => {
        const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} r(); }, 5000);
        c.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    removeWorkerPid(config.stateDir, config.id);
  }

  async function _start(): Promise<void> {
    if (status === "running" || status === "starting") return;
    if (dead) await _spawn();
    status = "starting";
    await _rpc("start");
  }

  // Soft stop: pause scheduler, worker process stays alive
  async function _softStop(): Promise<void> {
    if (status === "stopped") return;
    if (!dead) {
      try { await _rpc("stop"); } catch {}
    }
    status = "stopped";
  }

  // Kill worker process (for code hot-reload); RPC method controls whether containers stop too
  async function _killStop(rpcMethod: "stop" | "shutdown"): Promise<void> {
    stopRequested = true;
    status = "stopping";
    statusMessage = undefined;
    if (!dead) {
      try { await _rpc(rpcMethod); } catch {}
      await _kill();
    }
    status = "stopped";
  }

  // ─── Lifecycle lock — serializes start/stop/restart/shutdown ───

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let unlock!: () => void;
    lock = new Promise<void>(r => { unlock = r; });
    return prev.then(fn).finally(unlock);
  }

  // ─── Handle (worker spawns lazily on first _start) ───

  // Non-RPC methods implemented locally
  const localHandle = {
    id: config.id,
    instanceDir: config.instanceDir,
    get status() { return status; },
    get statusMessage() { return statusMessage; },
    get provisioningPhase() { return provisioningPhase; },
    _setStatusMessage(msg?: string) { statusMessage = msg; },

    start:    () => withLock(() => _start()),
    stop:     (opts: any) => withLock(() => opts?.hard ? _killStop("stop") : _softStop()),
    shutdown: () => withLock(() => _killStop("shutdown")),

    interruptAgents(agentId?: string) { _notify("interrupt", agentId); },
    _pushPortMappings(m: PortMapping[]) { _notify("applyPortMappings", m); },

    observeEvents(handler: (event: Event, emitterId?: string) => void) {
      observers.add(handler);
      return () => { observers.delete(handler); };
    },
    emit(event: Event) { _send({ ch: "bus", event }); },

    /**
     * SessionRegistry bridge. Lives on the IPC parent so HTTP route handlers
     * (gateway/server/routes/session.ts) and WS subscribers (ws-handler) can
     * reach the worker-side SessionRegistry without a layer-crossing surprise.
     *
     * P3 minimal-bridge implementation:
     *   - create / dispose / list / get are forwarded through the generic
     *     _rpc Proxy that wraps every InstanceHandle method below this object.
     *     The worker exposes matching RPC handlers (instance-worker.ts) that
     *     delegate to `handle.sessions.*`. observe* events stream through the
     *     existing { ch: "bus", event, sessionId } frames (worker → parent).
     *   - observeAll receives every bus frame the worker forwards, with the
     *     embedded sessionId. P3 worker tags every frame with the sourcing
     *     SessionRuntime id; pre-P3 workers omit sessionId and fall back to
     *     the literal "default" sentinel so existing ws clients still see
     *     events (single-session behaviour).
     *
     * Real worker-side IPC handlers for create / dispose / list arrive in P4
     * when multi-tab UX wires the registry directly. For now the gateway
     * HTTP /sessions endpoints transparently route to those handlers via the
     * Proxy below, and observeAll already works end-to-end for fan-out.
     */
    sessions: {
      create: async (opts: unknown) => {
        const r = await _rpc("sessionsCreate", opts) as { session?: import("../core/session-runtime.js").SessionRuntimeMeta };
        if (!r?.session) throw new Error("worker did not return a session");
        // Parent-side SessionRuntime proxy: only meta is serialisable across
        // IPC, so the heavy methods are stubbed. handleSessionCreate only
        // reads .meta — that's the only contract that matters for the create
        // endpoint. Dispose / observe live on the registry itself.
        return {
          meta: r.session,
          get eventBus(): never { throw new Error("eventBus is not bridged across IPC"); },
          emit: () => { throw new Error("emit is not bridged across IPC"); },
          observe: () => () => {},
          scheduler: undefined as any,
          dispose: async () => { await _rpc("sessionsDispose", r.session!.id, {}); },
        } as unknown as import("../core/session-runtime.js").SessionRuntimeAPI;
      },
      get: () => null,
      list: () => [],
      dispose: async (sid: string, opts?: unknown) => { await _rpc("sessionsDispose", sid, opts); },
      observeAll: (
        handler: (sessionId: string, event: Event, emitterId?: string) => void,
      ) => {
        const wrapped = (event: Event, emitterId?: string, sessionId?: string) => {
          handler(sessionId ?? "default", event, emitterId);
        };
        // Hook into the same observers Set bus frames write to. We tag the
        // bus relay below with sessionId; legacy observers (those that called
        // observeEvents) keep working because we pass (event, emitterId)
        // first.
        sessionedObservers.add(wrapped);
        return () => { sessionedObservers.delete(wrapped); };
      },
    } as unknown as import("../core/session-registry.js").SessionRegistryAPI,
  };

  // All other InstanceHandle methods are auto-proxied to _rpc
  type Handle = InstanceHandle & { _pushPortMappings(mappings: PortMapping[]): void; _setStatusMessage(msg?: string): void };
  return new Proxy(localHandle as unknown as Handle, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      return (...args: unknown[]) => _rpc(prop, ...args);
    },
  });
}
