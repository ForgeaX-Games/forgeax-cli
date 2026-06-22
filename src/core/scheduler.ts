/** @desc Scheduler — agent runtime orchestration (start/stop/run loops) */

import { join } from "node:path";
import { existsSync, renameSync } from "node:fs";
import type {
  AgentJson,
  AgentInitConfig,
} from "./types.js";
import { EventBus } from "./event-bus.js";
import { initGlobalEventLog, stopGlobalEventLog } from "../session/system-event-log.js";

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: Scheduler | null = null;

export function setInstanceScheduler(s: Scheduler): void { _instance = s; }
export function getInstanceScheduler(): Scheduler | null { return _instance; }
import { TeamBoard } from "./team-board.js";
import { AgentTree } from "../tree/agent-tree.js";
import { ConsciousAgent } from "./conscious-agent.js";
import { ScriptAgent, SCRIPT_ENTRY_SEGMENTS } from "./script-agent.js";
import { BaseAgent } from "./base-agent.js";
import { getPathManager, type PathManager } from "../fs/path-manager.js";
import { createOrGetFSWatcher, getFSWatcher, type FSWatcher } from "../fs/watcher.js";
import { getTerminalManager, initTerminalManager } from "../terminal/manager.js";
import { ensureAgentTemplateFiles } from "../team/agent-scaffold.js";
import { Logger, attachConsoleEventEmitter, detachConsoleEventEmitter } from "./logger.js";
import { AgentReloadCoordinator } from "../loaders/agent-reload-coordinator.js";
import { AgentLifecycleLock } from "./agent-lifecycle-lock.js";

type AgentControlAction =
  | "start"
  | "shutdown"
  | "restart"
  | "remove";

export class Scheduler {
  private readonly pathManager: PathManager;
  private readonly teamBoard: TeamBoard;
  private readonly agentTree: AgentTree;
  private readonly terminalManager: ReturnType<typeof initTerminalManager>;
  private readonly logger: Logger;
  readonly eventBus = new EventBus();
  private get fsWatcher(): FSWatcher | null { return getFSWatcher(); }
  private agents = new Map<string, BaseAgent>();
  /** Back-pointer to the owning SessionRuntime. Set by SessionRegistry.create
   *  immediately after construction. Used to populate AgentInitConfig.sessionRuntime
   *  so per-agent context surfaces have a handle on their session. */
  sessionRuntime: import("./session-runtime.js").SessionRuntimeAPI | null = null;
  private shuttingDown = false;
  private reloadCoordinator: AgentReloadCoordinator | null = null;
  /**
   * Per-agent async lock serializing all lifecycle mutations on the same id
   * (initAgent / shutdownAgent / runAgent / agentTree.create|free). Both
   * polling (scriptSrcChanged) and public control API (doStart / doShutdown
   * / doRestart / doRemove) acquire it to prevent duplicate-instance races.
   * Implementation lives in agent-lifecycle-lock.ts.
   */
  private lifecycleLock = new AgentLifecycleLock();

  constructor(logger: Logger) {
    this.pathManager = getPathManager();
    this.teamBoard = new TeamBoard(this.pathManager.team().teamBoard());
    this.agentTree = new AgentTree(this.pathManager, this.eventBus);
    this.terminalManager = initTerminalManager();
    this.logger = logger;
  }

  /** Lightweight bootstrap — load teamBoard + FSWatcher, no agent discovery/start. */
  private _initialized = false;
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    this.migrateTeamBoard();
    this.teamBoard.loadFromDisk();
    this.agentTree.loadFromDisk();
    const watcher = createOrGetFSWatcher();
    this.teamBoard.registerFSWatcher(watcher);
  }

  /** Migrate teamboard.json from legacy agents/ path to shared-workspace/. */
  private migrateTeamBoard(): void {
    const legacyPath = join(this.pathManager.team().agentsDir(), "teamboard.json");
    if (existsSync(legacyPath)) {
      const newPath = this.pathManager.team().teamBoard();
      try {
        renameSync(legacyPath, newPath);
        console.log("[scheduler] Migrated teamboard.json from agents/ to shared-workspace/");
      } catch {
        console.warn("[scheduler] Failed to migrate teamboard.json — will start fresh at new path");
      }
    }
  }

  /** Access the shared TeamBoard instance. */
  getTeamBoard(): TeamBoard {
    return this.teamBoard;
  }

  /** Access the AgentTree instance. */
  getAgentTree(): AgentTree {
    return this.agentTree;
  }

  /** Access a agent by id. */
  getAgent(id: string): BaseAgent | null {
    return this.agents.get(id) ?? null;
  }

  async start(): Promise<void> {
    this.shuttingDown = false;
    console.log("启动中...");

    await this.init();

    initGlobalEventLog(this.pathManager.team().agentLedgersDir(), this.eventBus);

    attachConsoleEventEmitter((agentId, level, msg, toAgent) => {
      const event = {
        source: `agent:${agentId}`,
        type: "agent_log" as const,
        payload: { content: msg, [level === "warn" ? "warning" : "error"]: msg } as Record<string, string>,
        ts: Date.now(),
      };
      const agent = this.agents.get(agentId);
      if (toAgent && agent) {
        // withModelFeedback: route into agent's own queue → next turn's prompt sees it.
        agent.boundEventBus.emitToSelf({ ...event, handoff: "silent" as const });
      } else {
        // default: publish to observers — UI sees, model does NOT.
        // emitterId MUST be agentId so per-agent observers (AgentLedger
        // ledger, ink-renderer subscription) don't filter it out.
        this.eventBus.publish(event, agentId);
      }
    });

    const { all: agentIds } = await this.agentTree.syncFromDisk();

    if (agentIds.length === 0) {
      console.warn("team/agents/ 下没有发现任何脑区");
    }

    for (const agentId of agentIds) {
      await this.initAgent(agentId);
    }

    const watcher = createOrGetFSWatcher();

    this.reloadCoordinator = new AgentReloadCoordinator(
      watcher,
      this.pathManager,
      // Tree-wide id source: lets polling scan agents that exist in the tree
      // but aren't yet running (hot-create / revival after shutdown).
      () => this.agentTree.allNodes().map(n => n.id),
      // Unified src/-change dispatch — scheduler decides restart vs init+run
      // based on agents.has(id). Returns true if handled (caller advances
      // baseline), false if busy (caller keeps prev baseline; next tick retries).
      async (agentId) => this.scriptSrcChanged(agentId),
    );
    this.reloadCoordinator.startWatching();
    for (const agent of this.agents.values()) {
      this.reloadCoordinator.registerAgent(agent);
      agent.capabilityFlush = () => this.reloadCoordinator!.flushReloads();
    }
    this.agentTree.startWatching(watcher, {
      onAgentCreated: async (id) => {
        // Fast bailouts then delegate to doStart. createTreeIfMissing:false
        // is critical: a stale FS event arriving after doRemove already
        // freed the tree node must NOT trigger doStart's bootstrap path
        // (which would resurrect the dead agent). doStart re-checks all
        // state inside its lock; we just relay the event here.
        if (this.shuttingDown) return;
        if (this.agents.has(id)) return;
        const status = await this.doStart(id, { createTreeIfMissing: false });
        console.log(`hot-created agent '${id}': ${status}`);
      },
      onAgentFreed: async (id) => {
        // controlAgent("remove") → doRemove which itself enters lock.
        await this.controlAgent("remove", id);
      },
    });

    // ScriptAgent src/index.ts changes (hot-create / transformation /
    // hot-reload / revival) are handled by AgentReloadCoordinator polling
    // exclusively — see scriptSrcChanged below.

    for (const id of this.agents.keys()) {
      this.runAgent(id);
    }

    console.log("就绪，所有 agent loop 已启动");
  }

  private isScriptAgent(agentId: string): boolean {
    return existsSync(join(this.pathManager.agent(agentId).root(), ...SCRIPT_ENTRY_SEGMENTS));
  }

  private createAgentInitConfig(agentId: string, agentConfig: AgentJson): AgentInitConfig {
    return {
      id: agentId,
      agentDir: this.pathManager.agent(agentId).root(),
      agentJson: agentConfig,
      teamBoard: this.teamBoard,
      agentTree: this.agentTree,
      eventBus: this.eventBus,
      fsWatcher: this.fsWatcher ?? undefined,
      sessionRuntime: this.sessionRuntime ?? undefined,
    };
  }

  private async initAgent(agentId: string): Promise<void> {
    await ensureAgentTemplateFiles(agentId);
    const agentConfig = await BaseAgent.loadConfig(agentId);
    const baseConfig = this.createAgentInitConfig(agentId, agentConfig);

    await this.terminalManager.loadAgentEnv(agentId);

    let agent: BaseAgent;
    let label: string;

    if (this.isScriptAgent(agentId)) {
      agent = new ScriptAgent(baseConfig);
      label = `ScriptAgent '${agentId}' 就绪`;
    } else {
      agent = new ConsciousAgent(baseConfig);
      label = `脑区 '${agentId}' 就绪`;
    }

    try {
      await agent.initCapabilities();
      this.agents.set(agentId, agent);
      this.reloadCoordinator?.registerAgent(agent);
      if (this.reloadCoordinator) {
        agent.capabilityFlush = () => this.reloadCoordinator!.flushReloads();
      }
      console.log(label);
    } catch (err) {
      try { await agent.shutdown(); } catch (e) {
        console.error(`agent '${agentId}' rollback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      throw err;
    }
  }

  /** Shutdown agent and clear in-memory state. Dirs and tree node are preserved. */
  private async shutdownAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.reloadCoordinator?.unregisterAgent(id);
    await agent.shutdown();
    this.agents.delete(id);
  }

  // ─── Public API (runtime-only: start / shutdown / restart) ───

  async controlAgent(
    action: AgentControlAction,
    target: string,
  ): Promise<string> {
    console.log(`agent_control: ${action} → '${target}'`);

    switch (action) {
      case "start":     return this.doStart(target);
      case "shutdown":  return this.doShutdown(target);
      case "restart":   return this.doRestart(target);
      case "remove":    return this.doRemove(target);
    }
  }

  /**
   * Start an agent.
   *
   * `createTreeIfMissing` (default true): if the tree has no node for `id`,
   * create one. This is the public control API semantic — callers expect
   * "start this id, and bootstrap tree node if it doesn't exist yet".
   *
   * Pass `false` from watcher callbacks (e.g. onAgentCreated) where stale
   * FS events arriving after a doRemove must NOT resurrect the freed agent.
   * In that mode, missing tree node returns an error string instead of
   * silently rebuilding it.
   *
   * agentDir existence is also re-checked INSIDE the lock to avoid races
   * with doRemove deleting the directory between a stale pre-check and the
   * critical section.
   */
  private async doStart(
    id: string,
    opts: { createTreeIfMissing?: boolean } = {},
  ): Promise<string> {
    const createTreeIfMissing = opts.createTreeIfMissing ?? true;
    return this.lifecycleLock.acquire(id, async () => {
      if (this.agents.has(id)) return `Agent '${id}' is already running`;
      const agentDir = this.pathManager.agent(id).root();
      if (!existsSync(agentDir)) return `Agent directory not found: team/agents/${id}/`;
      if (!this.agentTree.has(id)) {
        if (!createTreeIfMissing) return `Agent '${id}' tree node missing (stale event)`;
        const result = await this.agentTree.create({ id });
        if (!result.ok) return result.error;
      }
      await this.initAgent(id);
      this.runAgent(id);
      return `Agent '${id}' started`;
    });
  }

  private async doShutdown(id: string): Promise<string> {
    return this.lifecycleLock.acquire(id, async () => {
      // Re-check inside lock: prior in-flight (e.g. scriptSrcChanged restart)
      // may have just brought it back, or doRemove may have already freed it.
      if (!this.agents.has(id)) return `Unknown agent: '${id}'`;
      await this.shutdownAgent(id);
      return `Agent '${id}' shut down`;
    });
  }

  private async doRestart(id: string): Promise<string> {
    return this.lifecycleLock.acquire(id, async () => {
      // Re-check inside lock: prior in-flight (e.g. doRemove) may have removed it.
      if (!this.agents.has(id)) return `Unknown agent: '${id}'`;
      await this.shutdownAgent(id);
      await this.initAgent(id);
      this.runAgent(id);
      return `Agent '${id}' restarted`;
    });
  }

  /** Shutdown + delete dirs + free tree node + wipe teamboard. Permanent. */
  private async doRemove(id: string): Promise<string> {
    // Lock the full lifecycle: any concurrent scriptSrcChanged / doStart /
    // doRestart against the same id must wait, then re-check state. Skip-if-busy
    // would let doRemove race with an in-flight init+run → "remove-then-revive".
    return this.lifecycleLock.acquire(id, async () => {
      await this.shutdownAgent(id);  // no-op if not running
      await this.agentTree.free(id).catch(() => {});
      try { this.teamBoard.removeAll(id); } catch { /* best-effort */ }
      return `Agent '${id}' removed`;
    });
  }

  // ─── ScriptAgent src/ change dispatch ───────────────────────────────────

  /**
   * Single trigger surface for ScriptAgent src/ lifecycle (hot-create / type
   * transformation / hot-reload / shutdown-revival). Called by
   * AgentReloadCoordinator.scanScriptSrc when an agent's src/index.ts hash
   * changes (or appears for the first time after the baseline was empty).
   *
   * Why polling-only: fs.watch recursive misses `open(O_TRUNC)+write+close`
   * writes on Linux ext4 — the dominant pattern for admin write_file / heredoc.
   * See homes/admin/memories/experience/fs-watch-truncate-mode-misses-events.md
   *
   * Concurrency: flushReloads is invoked per-ConsciousAgent-batch — N agents
   * → N-way concurrent calls. lifecycleLock (per-id async lock) serializes
   * to prevent parallel initAgent for the same agent (would spawn duplicate
   * ScriptAgent instances and crash with "Cannot read properties of undefined").
   *
   * Returns true if the change was handled (caller may advance baseline).
   * Returns false if skipIfBusy returned without entering the critical section
   * — caller MUST NOT advance baseline; next polling tick will retry.
   */
  private async scriptSrcChanged(id: string): Promise<boolean> {
    if (this.shuttingDown) return true;  // shutdown phase: ack as handled, no pending state
    if (!this.agentTree.has(id)) return true;  // tree freed: change is moot
    // skipIfBusy: if a concurrent lifecycle op is in-flight, return false so
    // the coordinator does NOT advance its baseline — the change must be
    // re-detected on the next polling tick once the lock frees.
    const result = await this.lifecycleLock.acquire<true>(id, async () => {
      if (this.shuttingDown) return true;
      if (!this.agentTree.has(id)) return true;
      try {
        if (this.agents.has(id)) {
          // Already running → restart picks up new content (and re-evaluates
          // isScriptAgent, handling ConsciousAgent → ScriptAgent transformation).
          await this.shutdownAgent(id);
          await this.initAgent(id);
          this.runAgent(id);
          console.log(`src/ changed → restarted agent '${id}'`);
        } else {
          // Not in agents map → hot-create or post-shutdown revival.
          await this.initAgent(id);
          this.runAgent(id);
          console.log(`src/ changed → started agent '${id}'`);
        }
      } catch (err: unknown) {
        console.error(`src/ change handling for '${id}' failed: ${(err as Error)?.message ?? err}`);
      }
      return true;
    }, { skipIfBusy: true });
    return result === true;  // undefined when skipIfBusy returned without entering fn
  }

  private runAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.run(agent.signal)
      .catch(err => {
        const msg = `agent loop crashed: ${(err as Error)?.message ?? err}`;
        console.error(msg);
        agent.boundEventBus.publish({
          source: `agent:${id}`, type: "agent_crash", ts: Date.now(),
          payload: { error: msg },
        });
        // Crash cleanup must (1) enter the same per-agent lifecycle lock so it
        // doesn't race with concurrent doRestart / scriptSrcChanged, and
        // (2) re-check that the current agents.get(id) is STILL the crashed
        // instance. Without the identity check, a stale catch handler from an
        // already-replaced instance could shut down the new live instance.
        void this.lifecycleLock.acquire(id, async () => {
          if (this.agents.get(id) !== agent) return;  // already replaced
          await this.shutdownAgent(id);
        }).catch(() => {});
      });
  }

  /** Abort all running agent loops (sets abort signal, does not shutdown). */
  interruptAgents(agentId?: string): void {
    if (agentId) {
      const agent = this.agents.get(agentId);
      if (agent) agent.stop();
    } else {
      for (const agent of this.agents.values()) agent.stop();
    }
  }

  async shutdownAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log("并行关闭所有 agents (10s 超时)...");

    const shutdownPromises = [...this.agents.entries()].map(async ([id, agent]) => {
      try {
        await agent.shutdown();
      } catch (err: any) {
        console.error(`shutdown agent '${id}' failed: ${err?.message ?? err}`);
      }
    });

    const timeout = new Promise<void>(resolve => setTimeout(resolve, 10_000));
    await Promise.race([Promise.all(shutdownPromises), timeout]);

    this.agents.clear();
    this._initialized = false;
    detachConsoleEventEmitter();
  }

  async destroyRuntime(): Promise<void> {
    await this.shutdownAll();
    this.reloadCoordinator?.stopWatching();
    this.reloadCoordinator = null;
    stopGlobalEventLog();
    this.agentTree.stopWatching();
    getFSWatcher()?.close();
    getTerminalManager().cleanup(0);
    await this.logger.close();
  }
}
