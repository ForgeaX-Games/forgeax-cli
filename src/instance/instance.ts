/** @desc Instance — createInstance() factory for subprocess runtime */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { InstanceHandle, InstanceConfig, ProvisioningPhase } from "../core/types.js";
import { getPathManager, initPathManager } from "../fs/index.js";
import { getSharedPaths } from "../fs/state-dir.js";
import { ConsciousAgent } from "../core/conscious-agent.js";
import { getConsoleLogger } from "../core/logger.js";
import { Scheduler } from "../core/scheduler.js";
import { SessionRegistry, DEFAULT_SESSION_ID } from "../core/session-registry.js";
import type { SessionRuntime } from "../core/session-runtime.js";
import { getSandboxManager, SandboxManager } from "../sandbox/manager.js";
import { createOrGetFSWatcher } from "../fs/watcher.js";
import { initTerminalManager, getTerminalManager } from "../terminal/manager.js";
import { ensureTeamDirs, ensureTeamBaseEnv, ensureMountsConfig, ensureTeamAgentsFilesystem } from "../team/team-scaffold.js";


function attachSchedulerListeners(scheduler: Scheduler): void {
  scheduler.eventBus.observe((event) => {
    if (event.type === "agent_command") {
      const p = event.payload as { toolName: string; args: Record<string, string>; agentId?: string; interrupt?: boolean };
      const targetId = p.agentId ?? event.to;
      if (!targetId) return;
      const agent = scheduler.getAgent(targetId);
      if (agent instanceof ConsciousAgent) {
        agent.queueCommand(p.toolName, p.args, undefined, p.interrupt ?? true);
      }
    }
  });
}

/**
 * Initialise the per-instance infrastructure that is SHARED across all
 * SessionRuntimes (path / sandbox / terminal / fswatcher / team dirs).
 *
 * The Scheduler itself is NOT created here anymore — that moves into
 * SessionRegistry.create() so each SessionRuntime gets its own. In P1 the
 * Instance bootstrap calls SessionRegistry.create({ sessionId: "default" })
 * exactly once, preserving the legacy single-scheduler shape.
 */
async function initSharedInfrastructure(
  pm: ReturnType<typeof getPathManager>,
  onStatus?: (message: string, phase?: ProvisioningPhase) => void,
): Promise<void> {
  createOrGetFSWatcher();

  try { getTerminalManager(); } catch { initTerminalManager(); }
  const terminalManager = getTerminalManager();

  const manifestPath = pm.team().manifest();
  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    throw new Error("Invalid manifest.json format");
  }

  await terminalManager.ensureReady();
  await ensureMountsConfig();
  onStatus?.("Initializing sandbox...", "initializing_sandbox");
  const sandbox = await SandboxManager.init();
  if (sandbox.isEnabled()) await sandbox.ensureSandbox(onStatus);
  onStatus?.("Setting up team directories...", "configuring_team");
  await ensureTeamDirs();
  await ensureTeamBaseEnv();
  await ensureTeamAgentsFilesystem();
  await terminalManager.loadSystemEnv();

  manifest.lastStartedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

export async function createInstance(
  config: InstanceConfig,
  onStatus?: (message: string, phase?: ProvisioningPhase) => void,
): Promise<InstanceHandle> {
  const { id, instanceDir, stateDir } = config;
  let status: InstanceHandle["status"] = "idle";

  initPathManager(getSharedPaths(stateDir).instanceDir(id), stateDir);
  const pm = getPathManager();

  let registry: SessionRegistry | null = null;
  let defaultSession: SessionRuntime | null = null;

  try {
    if (existsSync(pm.team().manifest())) {
      status = "stopped";  // has team but not yet started
      await initSharedInfrastructure(pm, onStatus);
      const logger = getConsoleLogger();
      if (!logger) throw new Error("Logger not initialized");
      registry = new SessionRegistry(logger);
      // P1: single fixed "default" SessionRuntime for back-compat with
      // every caller that goes through inst.emit / inst.observeEvents /
      // getInstanceScheduler(). Multi-session API is wired in P3.
      defaultSession = (await registry.create({ sessionId: DEFAULT_SESSION_ID })) as SessionRuntime;
      attachSchedulerListeners(defaultSession.scheduler);
    } else {
      console.log(`[Instance:${id}] No team loaded — instance is idle.`);
    }
  } catch (err: any) {
    if (err.message?.includes("No team manifest found")) {
      console.log(`[Instance:${id}] No team loaded — instance is idle.`);
    } else {
      throw err;
    }
  }

  // ── Internal accessor: every legacy callsite below routes through the
  //    default session's scheduler. In P3 the surface is widened to take
  //    an explicit sessionId. ──
  const sched = (): Scheduler | null => defaultSession?.scheduler ?? null;

  // Minimal SessionRegistry stub for the "no team loaded" branch — the
  // interface promises sessions is non-null, so we expose an empty one.
  const emptyRegistry: import("../core/session-registry.js").SessionRegistryAPI = {
    create: async () => { throw new Error(`Instance "${id}" has no team loaded — cannot create sessions`); },
    get: () => null,
    list: () => [],
    dispose: async () => {},
    observeAll: () => () => {},
  };

  const handle: InstanceHandle = {
    id,
    instanceDir,
    get status() { return status; },
    get sessions() { return registry ?? emptyRegistry; },

    async start() {
      const s = sched();
      if (!s) return;
      status = "starting";
      try {
        await s.start();
        status = "running";
      } catch (err) {
        status = "error";
        throw err;
      }
    },

    async stop() {
      const s = sched();
      if (!s) return;
      status = "stopping";
      await s.shutdownAll();
      status = "stopped";
    },

    async shutdown() {
      if (!registry) return;
      status = "stopping";
      await registry.disposeAll();
      await getSandboxManager()?.stopAllRegistered();
      status = "stopped";
    },

    interruptAgents(agentId?: string) {
      sched()?.interruptAgents(agentId);
    },

    observeEvents(handler) {
      const session = defaultSession;
      if (!session) return () => {};
      return session.observe(handler);
    },

    emit(event) {
      defaultSession?.emit(event);
    },

    // ── Commands (instance-scoped, stateless) ──

    async listCommands(requestingAgentId?: string) {
      const s = sched();
      if (!s) return { commands: [] };
      const { listAllCommands } = await import("../capability/command/runner.js");
      const ctx = { scheduler: s, instanceDir, requestingAgentId };
      return { commands: await listAllCommands(ctx) };
    },

    async commandQuery(name: string, args: string[], options?: { requestingAgentId?: string }) {
      const s = sched();
      if (!s) return { ok: false as const, error: "Instance not running" };
      const { callQuery } = await import("../capability/command/runner.js");
      const ctx = { scheduler: s, instanceDir, requestingAgentId: options?.requestingAgentId };
      return callQuery(name, args, ctx);
    },

    async commandExecute(name: string, args: string[], options?: { requestingAgentId?: string }) {
      const s = sched();
      if (!s) return { ok: false as const, error: "Instance not running" };
      const { callExecute } = await import("../capability/command/runner.js");
      const ctx = { scheduler: s, instanceDir, requestingAgentId: options?.requestingAgentId };
      return callExecute(name, args, ctx);
    },

  };

  return handle;
}
