/** @desc BaseAgent — abstract base class for all agent implementations */

import { readFile } from "node:fs/promises";
import { deepMerge } from "./deep-merge.js";
import type {
  AgentInterface,
  AgentInitConfig,
  AgentJson,
  Event,
  SelfEvent,
  EventBusAPI,
  TeamBoardAPI,
  AgentTreeAPI,
  AgentContext,
  FSWatcherAPI,
  WatchRegistration,
} from "./types.js";
import { runWithAgentTurn, runWithAgentScope, bindAgentScope } from "./logger.js";
import type { EventBus } from "./event-bus.js";
import { EventQueue } from "./event-queue.js";
import { AGENT_DEFAULTS } from "../defaults/agent/agent-json.js";
import { Hook, createHookEvent } from "../hooks/types.js";
import { PluginLoader } from "../loaders/plugin-loader.js";
import { PluginRegistry } from "../registries/plugin-registry.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { ToolRegistry } from "../registries/tool-registry.js";
import { SlotLoader } from "../loaders/slot-loader.js";
import { SlotRegistry } from "../registries/slot-registry.js";
import { getPathManager } from "../fs/path-manager.js";
import { createAgentFs } from "../sandbox/fs-bridge.js";
import { AgentLedger } from "../session/agent-ledger.js";

export abstract class BaseAgent implements AgentInterface {
  readonly id: string;

  // Agent-specific config
  protected agentJson: AgentJson;
  protected readonly agentDir: string;

  // Self-owned components (unique per instance)
  readonly queue: EventQueue;
  protected abortController = new AbortController();
  protected shuttingDown = false;

  // Shared singletons (passed in via config)
  protected readonly teamBoard: TeamBoardAPI;
  protected readonly agentTree: AgentTreeAPI;
  protected readonly eventBus: EventBus;
  protected readonly fsWatcher?: FSWatcherAPI;
  /** Back-pointer to the SessionRuntime that owns this agent. P2+. */
  protected readonly sessionRuntime?: import("./session-runtime.js").SessionRuntimeAPI;

  /** Agent-bound EventBus facade exposed to tools, plugins and scheduler. */
  readonly boundEventBus: EventBusAPI;
  /** Agent-bound TeamBoard facade — watch callbacks auto-inherit agent scope. */
  readonly boundTeamBoard: TeamBoardAPI;

  /** Stable AgentContext shared across loaders, plugins, slots and external callers. */
  readonly agentContext: AgentContext;

  // Loaders (stateless — only hold kind + logContext + generation counter)
  protected readonly pluginLoader: PluginLoader;
  protected readonly toolLoader: ToolLoader;
  protected readonly slotLoader: SlotLoader;

  // Registries (the single source of truth for loaded capabilities)
  protected readonly pluginRegistry: PluginRegistry;
  protected readonly toolRegistry: ToolRegistry;
  protected readonly slotRegistry: SlotRegistry;

  readonly ledger: AgentLedger;

  protected capabilitiesInitialized = false;
  private agentJsonWatchReg: WatchRegistration | null = null;
  private overridesWatchReg: WatchRegistration | null = null;

  /** Set by Scheduler to enable proactive capability reload after tool batches. */
  capabilityFlush?: () => Promise<boolean>;

  constructor(config: AgentInitConfig) {
    this.id = config.id;
    this.agentDir = config.agentDir;
    this.agentJson = config.agentJson;

    // Shared singletons
    this.teamBoard = config.teamBoard;
    this.agentTree = config.agentTree;
    this.eventBus = config.eventBus;
    this.fsWatcher = config.fsWatcher;
    this.sessionRuntime = config.sessionRuntime;

    // Self-owned components
    this.queue = new EventQueue();

    // Register this agent's queue with the event bus
    this.eventBus.register(this.id, this.queue);

    // Bound facade:
    //   publish(event) — observers only, no queue routing.
    //   emit(event)    — observers + route via event.to, broadcast skips self.
    const agentId = this.id;
    const bus = this.eventBus;
    this.boundEventBus = {
      publish: (event: Event, emitterId?: string) => bus.publish(event, emitterId ?? agentId),
      emit: (event: Event, emitterId?: string) => bus.emit(event, emitterId ?? agentId),
      emitToSelf: (event: SelfEvent) => bus.emit({ ...event, to: agentId }, agentId),
      hook: (type, payload) => {
        const event = createHookEvent(type, payload, `agent:${agentId}`);
        bus.publish(event, agentId);
        return event;
      },
      observe: (handler: (event: Event, emitterId?: string) => void) =>
        bus.observe(bindAgentScope(agentId, handler)),
      observeAgent: (targetId: string, handler: (event: Event) => void) =>
        bus.observeAgent(targetId, bindAgentScope(agentId, handler)),
    };

    const board = this.teamBoard;
    this.boundTeamBoard = {
      set: (aid, key, val, opts) => board.set(aid, key, val, opts),
      get: (aid, key) => board.get(aid, key),
      remove: (aid, key) => board.remove(aid, key),
      removeAll: (aid) => board.removeAll(aid),
      removeByPrefix: (prefix) => board.removeByPrefix(prefix),
      getAll: (aid) => board.getAll(aid),
      agentIds: () => board.agentIds(),
      watch: (aid, key, cb) => board.watch(aid, key, bindAgentScope(agentId, cb)),
      loadFromDisk: () => board.loadFromDisk(),
      registerFSWatcher: (w) => board.registerFSWatcher(w),
    };

    // Loaders — stateless, only need logContext
    this.pluginLoader = new PluginLoader();
    this.pluginLoader.setLogContext(this.id);
    this.toolLoader = new ToolLoader();
    this.toolLoader.setLogContext(this.id);
    this.slotLoader = new SlotLoader();
    this.slotLoader.setLogContext(this.id);

    // Registries
    this.pluginRegistry = new PluginRegistry();
    this.pluginRegistry.setLogContext(this.id);
    this.toolRegistry = new ToolRegistry();
    this.slotRegistry = new SlotRegistry();

    // Per-agent event ledger (one AgentLedger per BaseAgent — owned for the
    // agent's full lifetime; "Session" at the conversation level is one layer
    // up, in SessionRuntime). The session id (when present) namespaces the
    // ledger path so two sessions hosting the same agent kind don't write to
    // the same shards.
    const sessionId = this.sessionRuntime?.meta.id ?? null;
    this.ledger = new AgentLedger(this.id, this.boundEventBus, this.fsWatcher, sessionId);

    // Base agentContext — subclasses patch specific fields after super()
    const self = this;
    this.agentContext = {
      agentId: this.id,
      agentDir: this.agentDir,
      get signal() { return self.abortController.signal; },
      eventBus: this.boundEventBus,
      teamBoard: this.boundTeamBoard,
      pathManager: getPathManager(),
      fs: createAgentFs(getPathManager(), this.teamBoard, this.id),
      getAgentJson: () => this.agentJson,
      tree: config.agentTree,
      hook: Hook,
      ledger: this.ledger,
      session: this.sessionRuntime,
      slots: this.slotRegistry,
      tools: this.toolRegistry,
      plugins: this.pluginRegistry,
    };

    // SlotLoader needs agentContext as its SlotContext
    this.slotLoader.setSlotContext(this.agentContext);
    this.pluginRegistry.setContext(this.agentContext);
  }

  /** Shared agent entrypoint: installs the root logging context. */
  async run(signal: AbortSignal): Promise<void> {
    await this.withAgentScope(() => this.runMain(signal));
  }

  /** Subclasses implement their actual main loop here. */
  protected abstract runMain(signal: AbortSignal): Promise<void>;

  /** Run code under this agent's scope without a turn number. */
  protected withAgentScope<T>(fn: () => T): T {
    return runWithAgentScope(this.id, fn);
  }

  /** Run code under this agent's scope with a specific turn number. */
  protected withAgentTurn<T>(turn: number, fn: () => T): T {
    return runWithAgentTurn(this.id, turn, fn);
  }

  /**
   * Initialize capabilities: load all capability modules from disk.
   * FSWatcher-based hot-reload is managed by AgentReloadCoordinator
   * at the Scheduler level.
   */
  async initCapabilities(): Promise<void> {
    await this.ledger.ensureActive();
    await this.reloadCapabilities();
    this.capabilitiesInitialized = true;
  }

  private static readonly CAPABILITY_KINDS = ["plugins", "tools", "slots"] as const;

  /** Reload a specific capability kind, or all if omitted. */
  async reloadCapabilityKind(kind?: "tools" | "slots" | "plugins"): Promise<void> {
    const kinds = kind ? [kind] : BaseAgent.CAPABILITY_KINDS;
    for (const k of kinds) {
      switch (k) {
        case "plugins": {
          const plugins = await this.pluginLoader.load(this.agentContext);
          this.pluginRegistry.replaceStatic(plugins);
          console.log(`plugins reloaded: ${plugins.size} total`);
          break;
        }
        case "tools": {
          const tools = await this.toolLoader.load(this.agentContext);
          this.toolRegistry.replaceStatic(tools);
          console.log(`tools reloaded: ${tools.size} total`);
          break;
        }
        case "slots": {
          const slots = await this.slotLoader.load(this.agentContext);
          this.slotRegistry.replaceStatic(slots);
          console.log(`slots reloaded: ${slots.size} total`);
          break;
        }
      }
    }
  }

  /** Reload all capabilities (tools + slots + plugins) from disk. */
  protected async reloadCapabilities(): Promise<void> {
    await this.reloadCapabilityKind();
  }

  /** Stop the agent loop (abort signal) */
  stop(): void {
    this.abortController.abort();
  }

  /** Full shutdown: stop loop, close sources, unregister from eventBus */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.abortController.abort();
    this.agentJsonWatchReg?.dispose();
    this.agentJsonWatchReg = null;
    this.overridesWatchReg?.dispose();
    this.overridesWatchReg = null;
    this.fsWatcher?.unregisterOwner(this.id);
    this.eventBus.unregister(this.id);
    this.toolRegistry.clear();
    this.slotRegistry.clear();
    this.pluginRegistry.clear();
    this.ledger.destroy();
  }

  /** Load agent config: deepMerge(agent.json, agent-overrides.json). */
  static async loadConfig(agentId: string): Promise<AgentJson> {
    const agent = getPathManager().agent(agentId);
    let base: Record<string, unknown> = {};
    try { base = JSON.parse(await readFile(agent.config(), "utf-8")); } catch {}
    let overrides: Record<string, unknown> = {};
    try { overrides = JSON.parse(await readFile(agent.configOverrides(), "utf-8")); } catch {}
    return deepMerge(base, overrides) as AgentJson;
  }

  /** Reload config from disk into in-memory agentJson. */
  protected async reloadConfig(): Promise<void> {
    this.agentJson = await BaseAgent.loadConfig(this.id);
  }

  /**
   * Register FSWatcher-backed watches on agent.json and agent-overrides.json.
   * Either file changing triggers a full reload via reloadConfig().
   * Updates only the in-memory agentJson config — capability reloads are
   * driven by the AgentReloadCoordinator at the Scheduler level.
   * Enable/disable changes take effect immediately via runtime conditions.
   */
  protected watchAgentJson(): void {
    if (this.agentJsonWatchReg || !this.fsWatcher) return;
    const agentLayer = getPathManager().agent(this.id);
    const reload = () => {
      this.reloadConfig().catch((err) => {
        console.warn(`agent config reload ignored: ${err?.message ?? err}`);
      });
    };
    this.agentJsonWatchReg = this.fsWatcher.watchFile(agentLayer.config(),          reload, { ownerId: this.id });
    this.overridesWatchReg = this.fsWatcher.watchFile(agentLayer.configOverrides(), reload, { ownerId: this.id });
  }

  /** Complete cleanup: shutdown + clear teamBoard data */
  async free(): Promise<void> {
    this.eventBus.publish({
      source: `agent:${this.id}`,
      type: "agent_freed",
      payload: { agentId: this.id },
      ts: Date.now(),
    }, this.id);

    await this.shutdown();
    this.teamBoard.removeByPrefix(`${this.id}:`);
    this.teamBoard.removeAll(this.id);
    console.log("free() complete — teamBoard cleared");
  }

  /** Get the abort signal for this agent */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Get coalesce delay from config */
  protected get coalesceMs(): number {
    return this.agentJson.coalesceMs ?? AGENT_DEFAULTS.coalesceMs;
  }
}
