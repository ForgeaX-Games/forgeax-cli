/** BaseAgent —— 所有 agent 实现的抽象基类。
 *
 *  与 agenteam ref（312 行）对齐策略：
 *  - **id == agentPath**（"root", "root/iori", "root/iori/suzu"）—— Session 层唯一寻址用 path。
 *  - **不挂 SessionManager**：forgeax 一棵树一个 sid，Session 由顶层 SessionManager 单实例持有。
 *  - **持有 3 loader + 3 registry**（B1.1, 2026-05-20）：ToolRegistry / SlotRegistry /
 *    PluginRegistry 在 constructor 内 new，注入 `agentContext`。Loader 当前 `_loadInternal`
 *    仍是 stub（B1.2-B1.3），所以 `reloadKits()` 暂为 noop；registry 默认空。
 *    `ConsciousAgent.buildPrompt` 已经从 `agentContext.tools.list()` 拿工具列表 —— echo turn
 *    永远拿到空数组，与之前 caller-injected `getTools = () => []` 行为完全等价。
 *  - **AgentTree 已监听整棵子树的 agent.json**；单 agent reload 由 Scheduler 显式触发。
 *  - **runMain abstract**：ConsciousAgent / ScriptAgent 自实现。
 *
 *  自持组件：EventQueue + AbortController + 3 loader + 3 registry；
 *  共享单例（构造时注入）：EventBus / Blackboard / AgentTree。 */

import type {
  AgentContext,
  AgentJson,
  AgentTreeAPI,
  BlackboardAPI,
  Event,
  EventBusAPI,
  SelfEvent,
} from "../core/types";
import type { FSWatcherAPI, WatchRegistration } from "../fs/types";
import { Hook } from "../hooks/types";
import { EventBus } from "./event-bus";
import { EventQueue } from "./event-queue";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import { deepMerge } from "../utils/deep-merge";
import { readFile } from "node:fs/promises";
import { ToolRegistry } from "../kits/tool-registry";
import { SlotRegistry } from "../kits/slot-registry";
import { PluginRegistry } from "../kits/plugin-registry";
import { KitToolLoader } from "../kits/tool-loader";
import { KitSlotLoader } from "../kits/slot-loader";
import { KitPluginLoader } from "../kits/plugin-loader";
import { createAgentFs } from "../fs/agent-fs";
import { wrapAgentFsWithRecorder, type RecorderHooks } from "../fs/agent-fs-recorder";
import { getPathManager } from "../fs/path-manager";
import { getTerminalManager } from "../terminal/manager";

export interface AgentInitConfig {
  /** Agent path within session, e.g. "root/iori"; 也是 EventBus / Blackboard 的命名空间 key。 */
  agentPath: string;
  /** Filesystem root for this agent — typically `paths.session(sid).agent(path).root()`. */
  agentDir: string;
  /** Already-merged agent.json (deepMerge(base, overrides))；BaseAgent 自己不读盘。 */
  agentJson: AgentJson;
  /** Absolute game root resolved at agent build time (bug-20260522).
   *  Optional — existing unit tests that build BaseAgent directly may omit it. */
  sessionCwd?: string;
  eventBus: EventBus;
  blackboard: BlackboardAPI;
  tree: AgentTreeAPI;
  /** Optional FSWatcher singleton — when provided, enables agent.json hot-reload. */
  fsWatcher?: FSWatcherAPI;
  /** Optional file-activity recorder hooks supplied by Session. When present,
   *  `agentContext.fs` is wrapped so every mutation (write/append/rename/delete)
   *  appends to the per-session ledger and emits a `file-activity` bus event.
   *  Tests that build BaseAgent directly without a Session can omit this — the
   *  fs surface remains the bare `createAgentFs()` output, no recording. */
  fileRecorder?: RecorderHooks;
}

export abstract class BaseAgent {
  readonly agentPath: string;
  protected agentJson: AgentJson;
  protected readonly agentDir: string;

  readonly queue: EventQueue;
  protected abortController = new AbortController();
  protected shuttingDown = false;

  protected readonly blackboard: BlackboardAPI;
  protected readonly tree: AgentTreeAPI;
  protected readonly eventBus: EventBus;
  protected readonly fsWatcher?: FSWatcherAPI;

  private agentJsonWatchReg: WatchRegistration | null = null;

  /** Agent-bound EventBus —— emitterId 自动塞 agentPath，省得 caller 每次都填。 */
  readonly boundEventBus: EventBusAPI;
  readonly agentContext: AgentContext;

  // ─── kits subsystem（B1.1-B1.9 完整接通；reload-coordinator 见 B1.10）────────
  protected readonly toolLoader: KitToolLoader;
  protected readonly slotLoader: KitSlotLoader;
  protected readonly pluginLoader: KitPluginLoader;
  protected readonly toolRegistry: ToolRegistry;
  protected readonly slotRegistry: SlotRegistry;
  protected readonly pluginRegistry: PluginRegistry;

  constructor(config: AgentInitConfig) {
    this.agentPath = config.agentPath;
    this.agentDir = config.agentDir;
    this.agentJson = config.agentJson;
    this.blackboard = config.blackboard;
    this.tree = config.tree;
    this.eventBus = config.eventBus;
    this.fsWatcher = config.fsWatcher;

    this.queue = new EventQueue();
    this.eventBus.register(this.agentPath, this.queue);

    const me = this.agentPath;
    const bus = this.eventBus;
    this.boundEventBus = {
      publish: (event: Event, emitterId?: string) => bus.publish(event, emitterId ?? me),
      emit: (event: Event, emitterId?: string) => bus.emit(event, emitterId ?? me),
      emitToSelf: (event: SelfEvent) => bus.emit({ ...event, to: me } as Event, me),
      hook: (type, payload) => {
        const event: Event = { source: `agent:${me}`, type, payload, ts: Date.now() };
        bus.publish(event, me);
        return event;
      },
      observe: (handler) => bus.observe(handler),
      observeAgent: (targetId, handler) => bus.observeAgent(targetId, handler),
    };

    // Kit loaders + registries —— 与 ref base-agent.ts L130-141 等价：per-agent
    // 各自一套（loader 是 stateless 类，registry 持 static + dynamic 双 Map）。
    this.toolLoader = new KitToolLoader();
    this.slotLoader = new KitSlotLoader();
    this.pluginLoader = new KitPluginLoader();
    this.toolRegistry = new ToolRegistry();
    this.slotRegistry = new SlotRegistry();
    this.pluginRegistry = new PluginRegistry();

    const self = this;
    const pathManager = getPathManager();
    const baseAgentFs = createAgentFs(
      pathManager,
      this.blackboard,
      this.agentPath,
      this.agentDir,
      () => config.sessionCwd ?? this.agentJson.defaultDir,
    );
    const agentFs = config.fileRecorder
      ? wrapAgentFsWithRecorder(baseAgentFs, this.agentPath, config.fileRecorder)
      : baseAgentFs;
    this.agentContext = {
      agentPath: this.agentPath,
      agentDir: this.agentDir,
      cwd: config.sessionCwd ?? config.agentDir,
      get signal() { return self.abortController.signal; },
      eventBus: this.boundEventBus,
      blackboard: this.blackboard,
      tree: this.tree,
      hook: Hook,
      getAgentJson: () => this.agentJson,
      tools: this.toolRegistry,
      slots: this.slotRegistry,
      plugins: this.pluginRegistry,
      fs: agentFs,
      pathManager,
      terminal: getTerminalManager(),
    };

    // 与 ref base-agent.ts L165-167 等价：
    //   - slotLoader 需要 ctx 在 createInstance 时拿到（plumb 一次）
    //   - pluginRegistry 需要 ctx 在 replaceStatic 时决定要不要 start
    this.slotLoader.setSlotContext(this.agentContext);
    this.pluginRegistry.setContext(this.agentContext);
  }

  // ─── Kit lifecycle ────────────────────────────────────────────────────────

  /** 顺序：plugins 先（可能动态 register tool/slot），tools 次（dynamic plugin
   *  registered 的 tool 已落到 tools registry），slots 最后（slot 内可能读
   *  toolRegistry / pluginRegistry 状态）。与 ref BaseAgent.initCapabilities 一致。 */
  private static readonly KIT_KINDS = ["plugins", "tools", "slots"] as const;

  /** Per-kind reload. Loader 是 stateless 类，扫到的 instance 通过 registry
   *  `replaceStatic` 做 ref-equality diff —— 未变文件 instance 复用，registry
   *  side-effect 只对真变化触发（plugin start/stop 等）。 */
  async reloadKitKind(kind: "tools" | "slots" | "plugins"): Promise<void> {
    switch (kind) {
      case "plugins": {
        const plugins = await this.pluginLoader.load(this.agentContext);
        await this.pluginRegistry.replaceStatic(plugins);
        break;
      }
      case "tools": {
        const tools = await this.toolLoader.load(this.agentContext);
        this.toolRegistry.replaceStatic(tools);
        break;
      }
      case "slots": {
        const slots = await this.slotLoader.load(this.agentContext);
        this.slotRegistry.replaceStatic(slots);
        break;
      }
    }
  }

  /** Load all kit kinds from disk. Called by Scheduler.attachAgent so that
   *  registry 已就位之后才轮到 runAgent 跑第一个 turn。Idempotent —— 重复调
   *  通过 loader._inflight + _moduleCache 自动去重。 */
  async initKits(): Promise<void> {
    for (const k of BaseAgent.KIT_KINDS) {
      await this.reloadKitKind(k);
    }
  }

  /** Subclass entry point. Caller (Scheduler) 持锁调用，不需要 BaseAgent 自身排队。 */
  abstract run(signal: AbortSignal): Promise<void>;

  /** Abort current iteration; shutdown() 才是完整释放。 */
  stop(): void {
    this.abortController.abort();
  }

  /** Full shutdown：abort + 注销 queue + 清空 registries。FSWatcher 反注册延后到
   *  reload-coordinator（B1.8）接管时再做。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.abortController.abort();
    this.agentJsonWatchReg?.dispose();
    this.agentJsonWatchReg = null;
    if (this.fsWatcher) this.fsWatcher.unregisterOwner(this.agentPath);
    this.eventBus.unregister(this.agentPath);
    this.toolRegistry.clear();
    this.slotRegistry.clear();
    this.pluginRegistry.clear();
  }

  /** Register FSWatcher-backed watch on agent.json. Either file changing triggers
   *  a full reload via reloadAgentJson(). Call from subclass constructor. */
  protected watchAgentJson(): void {
    if (this.agentJsonWatchReg || !this.fsWatcher) return;
    const agentJsonPath = `${this.agentDir}/agent.json`;
    const reload = () => {
      this.reloadAgentJson().catch((err) => {
        process.stderr.write(`[base-agent] agent.json reload failed for '${this.agentPath}': ${err?.message ?? err}\n`);
      });
    };
    this.agentJsonWatchReg = this.fsWatcher.watchFile(agentJsonPath, reload, { ownerId: this.agentPath });
  }

  /** Reload agent.json from disk and update in-memory snapshot. */
  protected async reloadAgentJson(): Promise<void> {
    let raw: Record<string, unknown> = {};
    try {
      const txt = await readFile(`${this.agentDir}/agent.json`, "utf-8");
      raw = JSON.parse(txt) as Record<string, unknown>;
    } catch {
      // Missing or corrupt — fall back to defaults silently
    }
    this.setAgentJson(deepMerge(
      AGENT_DEFAULTS as unknown as Record<string, unknown>,
      raw,
    ) as unknown as AgentJson);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  protected get coalesceMs(): number {
    return this.agentJson.coalesceMs ?? AGENT_DEFAULTS.coalesceMs;
  }

  /** Replace in-memory agent.json（caller 在 reload 时调用）。 */
  setAgentJson(next: AgentJson): void {
    this.agentJson = next;
  }
}
