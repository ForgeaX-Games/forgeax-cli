/**
 * @desc Instance Worker — child process entry point.
 *
 * Launched by Gateway via fork(). Receives InstanceConfig through IPC,
 * creates a local InstanceHandle, then bridges all IPC messages to it.
 *
 * IPC protocol:
 *   ch:"ctl" type:"call"   — RPC: executes method, sends back result
 *   ch:"ctl" type:"notify" — one-way: executes method, no response
 *   ch:"bus"               — EventBus event forwarding (bidirectional)
 */

import { installConsoleBridge, Logger } from "../core/logger.js";

installConsoleBridge();

import "../llm/register-all.js";

import { createInstance } from "./instance.js";
import { getSandboxManager } from "../sandbox/manager.js";
import { setRecoveryCallbacks } from "../sandbox/container-recovery.js";
import type { InstanceHandle, InstanceConfig, Event, ProvisioningPhase } from "../core/types.js";
import { watch, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type ParentMsg =
  | { ch: "ctl"; type: "call"; callId: number; method: string; args: unknown[] }
  | { ch: "ctl"; type: "notify"; method: string; args: unknown[] }
  | { ch: "bus"; event: Event };

// IPC bridges only what the parent gateway process needs that isn't already on
// the commands transport: lifecycle controls, port-mapping notify, and the
// 3 command-system entry points. All agent-level data queries and introspection
// live in commands/*.ts and are reached via listCommands / commandQuery /
// commandExecute below (which the gateway exposes over HTTP + WS).
const METHODS: Record<string, (handle: InstanceHandle, ...args: any[]) => unknown | Promise<unknown>> = {
  start:             (h) => h.start(),
  stop:              (h) => h.stop(),
  shutdown:          (h) => h.shutdown(),
  interrupt:         (h, agentId) => h.interruptAgents(agentId as string | undefined),
  applyPortMappings: (_h, mappings) => getSandboxManager()?.applyPortMappings(mappings),
  listCommands:      (h, requestingAgentId) => h.listCommands(requestingAgentId as string | undefined),
  commandQuery:      (h, name, args, options) => h.commandQuery(name as string, (args as string[]) ?? [], options as { requestingAgentId?: string } | undefined),
  commandExecute:    (h, name, args, options) => h.commandExecute(name as string, (args as string[]) ?? [], options as { requestingAgentId?: string } | undefined),
  // P3+ session lifecycle RPC. observeAll-style streaming uses the bus
  // channel (instance-worker forwards every frame with sessionId) so we
  // only need request/response for the mutating calls.
  sessionsCreate:    async (h, opts) => {
    const rt = await h.sessions.create(opts as any);
    // Return only the serialisable meta — full SessionRuntime contains
    // EventBus / Scheduler refs that can't cross process boundaries.
    return { session: rt.meta };
  },
  sessionsDispose:   (h, sid, opts) => h.sessions.dispose(sid as string, opts as any),
  sessionsList:      (h) => h.sessions.list(),
  /** Publish an event to a specific SessionRuntime's bus. Used by the gateway
   *  HTTP /sessions/:sid/emit route, which lives on the parent process and
   *  cannot reach worker-side SessionRegistry instances directly. */
  sessionsEmit:      async (h, sid, eventPayload) => {
    const session = h.sessions.get(sid as string);
    if (!session) throw new Error(`Session "${sid}" not found`);
    session.emit(eventPayload as Event);
    return { accepted: true, sessionId: sid };
  },
  /** Returns the meta of one session if it exists, or null. Used by HTTP
   *  routes to check existence before mutating. */
  sessionsGetMeta:   (h, sid) => {
    const session = h.sessions.get(sid as string);
    return session ? session.meta : null;
  },
};

// ─── Boot ───

// Convert SIGTERM into a clean process.exit() so that 'exit' handlers fire.
// Without this, SIGTERM on a forked process terminates at OS level and Node.js
// exit handlers (including PortForwarder socat cleanup) never run.
process.on("SIGTERM", () => process.exit(0));

const configJson = process.env.__AGENTEAM_INSTANCE_CONFIG;
if (!configJson) {
  process.stderr.write("[InstanceWorker] Missing __AGENTEAM_INSTANCE_CONFIG env\n");
  process.exit(1);
}

const config: InstanceConfig = JSON.parse(configJson);

new Logger({
  debugLogPath: join(config.instanceDir, "debug.log"),
  agentLogsDir: join(config.instanceDir, "team", "logs"),
});

let handle: InstanceHandle;
let ipcClosed = false;

process.on("disconnect", () => {
  ipcClosed = true;
  process.stderr.write("[InstanceWorker] parent IPC disconnected; exiting worker\n");
  process.exit(0);
});

function isIpcClosedError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_IPC_CHANNEL_CLOSED";
}

function send(msg: Record<string, unknown>): boolean {
  if (ipcClosed || typeof process.send !== "function" || process.connected === false) {
    ipcClosed = true;
    return false;
  }
  try {
    process.send(msg);
    return true;
  } catch (err) {
    if (isIpcClosedError(err)) {
      ipcClosed = true;
      return false;
    }
    throw err;
  }
}

process.on("uncaughtException", (err) => {
  if (isIpcClosedError(err)) {
    ipcClosed = true;
    process.stderr.write("[InstanceWorker] IPC channel closed; exiting worker\n");
    process.exit(0);
  }
  console.error("[InstanceWorker] uncaughtException:", err);
  try { send({ ch: "ctl", type: "status", status: "error" }); } catch {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[InstanceWorker] unhandledRejection:", reason);
});

(async () => {
  try {
    const sendProvisioningStatus = (message: string, phase?: ProvisioningPhase): void => {
      send({ ch: "ctl", type: "status", status: "provisioning", statusMessage: message, provisioningPhase: phase });
    };

    const hasTeam = existsSync(join(config.instanceDir, "team", "manifest.json"));
    if (hasTeam) sendProvisioningStatus("Initializing team runtime...");

    handle = await createInstance(config, sendProvisioningStatus);
    setRecoveryCallbacks(sendProvisioningStatus, (error) => {
      if (error) {
        send({ ch: "ctl", type: "status", status: "error", statusMessage: error });
      } else {
        send({ ch: "ctl", type: "status", status: handle.status, statusMessage: "" });
      }
    });

    // P3+: relay every SessionRuntime's events, not just the default
    // session's. Each frame carries its source sessionId so the parent
    // process can route per-tab. Falls back to observeEvents only when the
    // instance has no team loaded (no SessionRegistry, just an empty stub).
    if (handle.sessions && typeof handle.sessions.observeAll === "function") {
      handle.sessions.observeAll((sessionId: string, event: Event, emitterId?: string) => {
        send({ ch: "bus", event, emitterId, sessionId });
      });
    } else {
      handle.observeEvents((event: Event, emitterId?: string) => {
        send({ ch: "bus", event, emitterId });
      });
    }

    send({ ch: "ctl", type: "ready", id: handle.id, status: handle.status });

    // ── FSWatcher: monitor manifest.json ports for changes ──
    const manifestPath = join(config.instanceDir, "team", "manifest.json");
    let lastPortsJson = "";

    function readCurrentPorts(): number[] {
      try {
        if (!existsSync(manifestPath)) return [];
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        return Array.isArray(m?.sandbox?.ports) ? m.sandbox.ports : [];
      } catch { return []; }
    }

    const initialPorts = readCurrentPorts();
    lastPortsJson = JSON.stringify(initialPorts);
    if (initialPorts.length > 0) {
      setImmediate(() => send({ ch: "ctl", type: "portsChanged", ports: initialPorts }));
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      watch(manifestPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const ports = readCurrentPorts();
          const json = JSON.stringify(ports);
          if (json !== lastPortsJson) {
            lastPortsJson = json;
            send({ ch: "ctl", type: "portsChanged", ports });
          }
        }, 200);
      });
    } catch {}
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    send({ ch: "ctl", type: "ready", id: config.id, status: "error", error: msg });
    return;
  }

  process.on("message", async (raw: ParentMsg) => {
    if (raw.ch === "bus") { handle.emit(raw.event); return; }

    const fn = METHODS[raw.method];

    if (raw.type === "notify") {
      if (fn) try { await fn(handle, ...raw.args); } catch (e) {
        console.error(`[InstanceWorker] notify ${raw.method} failed:`, e);
      }
      return;
    }

    if (raw.type === "call") {
      const { callId, method } = raw;
      if (!fn) {
        send({ ch: "ctl", type: "result", callId, ok: false, error: `Unknown method: ${method}` });
        return;
      }
      try {
        const value = await fn(handle, ...raw.args);
        send({ ch: "ctl", type: "result", callId, ok: true, value: value ?? null });
      } catch (err: unknown) {
        send({ ch: "ctl", type: "result", callId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      send({ ch: "ctl", type: "status", status: handle.status });
    }
  });
})();
