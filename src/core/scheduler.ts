/** Scheduler —— per-Session 的 agent 编排器（attach / start / route / shutdown）。
 *
 *  与 agenteam ref `core/scheduler.ts`（480 行）的差异：
 *  - **per-Session**：每个 Session 自带一份 Scheduler 实例（plan §3.1.1）。Session 关闭就
 *    `scheduler.shutdown()`，singleton getter 不再需要。
 *  - **不挂 TerminalManager / AgentReloadCoordinator / FSWatcher**：terminal manager 不在
 *    本轮（plan §8 明确删），src/ 改动热重载等到 ScriptAgent body 阶段；本轮 Scheduler 只负责
 *    agent 启停 + EventBus 队列路由 + lifecycle lock。
 *  - **不挂 systemEventLog / consoleEventEmitter**：单例日志桥由 SessionManager 在更外层接，
 *    Scheduler 不再 attach/detach。
 *  - **AgentTree 接口对齐 forgeax**：用 `tree.list()` 拿当前快照（无状态 readdir）+
 *    `tree.onChange()` 拿 fs-watcher 派发的 add/remove 事件做自动 attach/detach。
 *    AgentTree 内部用项目统一的 `FSWatcher`（src/fs/watcher.ts，引用计数 + debounce），
 *    不裸调 node:fs.watch、不依赖 chokidar。
 *  - **agentId == agentPath**（"root" / "root/iori"），与 BaseAgent 一致。
 *  - **ledger / sessionDefaultModels / kit 注入** 走 `agentFactory` 回调：caller (Session) 提供
 *    `(node) => Promise<BaseAgent>`，Scheduler 不直接 new ConsciousAgent，避免它再去管 ledger
 *    / sandbox / kit 注入这些 Session 层的细节。
 *  - **保留** ：lifecycleLock、controlAgent("start"|"shutdown"|"restart"|"remove")、runAgent
 *    crash recovery、shutdownAll 10s 超时、interruptAgents、AgentTree onChange 联动。
 *
 *  Singleton：本轮不再设 instance getter——Session 自己持有 scheduler 引用就行。 */

import type {
  AgentTreeAPI,
  Event,
  SchedulerAPI,
  TreeChange,
} from "./types";
import type { BaseAgent } from "./base-agent";
import { EventBus } from "./event-bus";
import { AgentLifecycleLock } from "./agent-lifecycle-lock";
import { runWithAgentScope, runWithSession, type Logger } from "./logger";

export type AgentControlAction = "start" | "shutdown" | "restart" | "remove";

/** Caller-injected agent factory —— Scheduler 不直接构造 ConsciousAgent / ScriptAgent，
 *  避免反向依赖 ledger / sandbox / kit 系统。Session 在 attach 一个 agent 时通过这个回调
 *  把已经准备好（ledger 注入、kit registry 注入、sessionDefaultModels 注入）的 agent 实例
 *  交给 Scheduler 调度。 */
export type AgentFactory = (agentPath: string) => Promise<BaseAgent>;

export interface SchedulerInitConfig {
  /** Owner session sid —— Scheduler 把所有 agent run / lifecycle 调用包在
   *  `runWithSession(sid, ...)` 内，让该栈下 `console.*` 自动落到 session 的
   *  logger 文件（`<sid>/logs/debug.log` + `latest.log`），不再污染 user-root
   *  debug.log（那里只承接 SessionManager 的元事件）。 */
  sid: string;
  eventBus: EventBus;
  tree: AgentTreeAPI;
  agentFactory: AgentFactory;
  /** Per-Session logger —— plumbing 错误（attach / shutdown / restart 等）
   *  统一走它，落到 `<sid>/logs/debug.log`。可选，未提供时落 stderr。 */
  logger?: Logger;
  /** Free agent's external state when its tree node is removed. Caller (Session)
   *  uses this to wipe blackboard namespace / dispose ledger / etc. Optional —
   *  Scheduler itself only owns lifecycle of the agent instance. */
  onAgentFreed?: (agentPath: string) => void | Promise<void>;
  /** Hook fired after `attachAgent` successfully puts a freshly-built agent
   *  into the running map（initKits 已完成）. Session 用它把 agent 注册到
   *  AgentKitReloadCoordinator，让 fs.watch 跟 polling 都开始覆盖它。 */
  onAgentAttached?: (agent: BaseAgent) => void | Promise<void>;
  /** Hook fired immediately before an agent is removed from the running map
   *  via shutdown / restart / remove。Session 用它从 coordinator 反注册 +
   *  反注册该 agent 的 per-agent kit dir 监听 owner。 */
  onAgentDetached?: (agentPath: string) => void | Promise<void>;
}

export class Scheduler implements SchedulerAPI {
  private readonly sid: string;
  private readonly eventBus: EventBus;
  private readonly tree: AgentTreeAPI;
  private readonly agentFactory: AgentFactory;
  private readonly logger?: Logger;
  private readonly onAgentFreed?: (agentPath: string) => void | Promise<void>;
  private readonly onAgentAttached?: (agent: BaseAgent) => void | Promise<void>;
  private readonly onAgentDetached?: (agentPath: string) => void | Promise<void>;

  private readonly agents = new Map<string, BaseAgent>();
  private readonly lifecycleLock = new AgentLifecycleLock();
  private treeUnwatch: (() => void) | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(config: SchedulerInitConfig) {
    this.sid = config.sid;
    this.eventBus = config.eventBus;
    this.tree = config.tree;
    this.agentFactory = config.agentFactory;
    this.logger = config.logger;
    this.onAgentFreed = config.onAgentFreed;
    this.onAgentAttached = config.onAgentAttached;
    this.onAgentDetached = config.onAgentDetached;
  }

  /** Run any callback inside this session's ALS scope —— sid 推进 LogContext，
   *  使该栈内所有 `console.*` 自动路由到 `<sid>/logs/debug.log + latest.log`。
   *  所有需要让 logger 命中 session 文件的入口都包一层（runAgent / lifecycle
   *  helpers / shutdown / start 的 tree watcher 等）。 */
  private inSession<T>(fn: () => T): T {
    return runWithSession(this.sid, fn);
  }

  private _warn(agentPath: string, msg: string): void {
    if (this.logger) this.logger.warn(agentPath, undefined, msg);
    else process.stderr.write(`[scheduler] ${agentPath ? `[${agentPath}] ` : ""}${msg}\n`);
  }
  private _error(agentPath: string, msg: string): void {
    if (this.logger) this.logger.error(agentPath, undefined, msg);
    else process.stderr.write(`[scheduler] ${agentPath ? `[${agentPath}] ` : ""}${msg}\n`);
  }

  // ─── SchedulerAPI ────────────────────────────────────────────────────────

  /** Attach an agent: factory build + initKits + register。Idempotent —— 已 attach 直接返回。
   *
   *  initKits 必须在 startAgent 之前完成 —— 让 runAgent 第一次 turn 时 tool/
   *  slot/plugin registry 已经填充好，否则 turn 0 会看到空 registry，等 reload
   *  追上时已经走过了 prompt 装配。任一 kit 加载失败不阻断 attach（错误已经在
   *  loader 内 logged），只是该 kit 缺席当前 turn。 */
  async attachAgent(agentPath: string): Promise<void> {
    await this.inSession(() => this.lifecycleLock.acquire(agentPath, async () => {
      if (this.agents.has(agentPath)) return;
      const agent = await this.agentFactory(agentPath);
      try {
        await agent.initKits();
      } catch (err: any) {
        this._error(agentPath, `initKits failed: ${err?.message ?? err}`);
      }
      this.agents.set(agentPath, agent);
      if (this.onAgentAttached) {
        try { await this.onAgentAttached(agent); }
        catch (err: any) {
          this._error(agentPath, `onAgentAttached failed: ${err?.message ?? err}`);
        }
      }
    }));
  }

  /** Start scheduling for a single agent；caller 须先 attach。Idempotent。 */
  async startAgent(agentPath: string): Promise<void> {
    await this.inSession(() => this.lifecycleLock.acquire(agentPath, async () => {
      const agent = this.agents.get(agentPath);
      if (!agent) return;
      this.runAgent(agentPath, agent);
    }));
  }

  /** Push an external event into the agent's inbox. */
  routeMessage(agentPath: string, event: Event): void {
    this.eventBus.emit({ ...event, to: agentPath });
  }

  /** Begin processing for the whole session：把当前盘上 tree 节点 attach + start
   *  一次，并订阅 tree.onChange 做新增/删除的自动 attach/detach（fs-watcher
   *  事件驱动，包括外部 mkdir/rm 也覆盖）。
   *
   *  **注意**：`agent_added` / `agent_removed` 事件**只**在 onChange 真实派发时
   *  publish —— 是真实 delta，不是 boot 时重放快照。前端拿初始快照走
   *  `list_agents` 一次性 REST 拉（snapshot），增量再靠这里 publish 出来的
   *  事件追（delta）。如果在 start() 里给现存节点也 publish 一遍，就会污染
   *  `<sid>/global-events.jsonl`（每次 server 重启加一条幽灵 added），而且
   *  ws.open 时 scheduler 已 started，初始扫盘 publish 永远到不了客户端。 */
  start(): void {
    if (this.started || this.shuttingDown) return;
    this.started = true;

    this.inSession(() => {
      for (const node of this.tree.list()) {
        void this.attachAndStart(node.path);
      }

      // 订阅 tree 变化 —— callback 由 FSWatcher 在 fs.watch 派发栈里调，
      // escape 当前 ALS，所以**必须**在 callback 内重新 enter session scope。
      this.treeUnwatch = this.tree.onChange(async (changes: TreeChange[]) => {
        if (this.shuttingDown) return;
        await this.inSession(async () => {
          for (const change of changes) {
            if (change.kind === "added") {
              void this.attachAndStart(change.node.path);
              this._publishTreeChange("agent_added", change.node.path);
            } else {
              await this.controlAgent("remove", change.node.path);
              this._publishTreeChange("agent_removed", change.node.path);
            }
          }
        });
      });
    });
  }

  /** 把 tree 拓扑变更广播到 eventBus —— 走 publish（observe-only，不进任何
   *  agent inbox / ledger，仅 UI / system-event-log 观察）。payload 带
   *  `path/display/depth/fullId` 方便前端直接 PATCH UI 状态，不必再调
   *  list_agents。 */
  private _publishTreeChange(type: "agent_added" | "agent_removed", agentPath: string): void {
    // node 可能已经从盘上移除（agent_removed 时 readdir 拿不到），所以构造
    // payload 用 path 拆解的最小信息，与 AgentTree.makeNode 的算法一致。
    const segs = agentPath.split("/").filter(Boolean);
    const display = segs[segs.length - 1] ?? "";
    const depth = segs.length;
    const fullId = `${display}#${depth}`;
    this.eventBus.publish({
      source: "session",
      type,
      payload: { content: agentPath, path: agentPath, display, depth, fullId },
      ts: Date.now(),
    });
  }

  /** Soft stop —— 并行 shutdown 所有 agents，10s 总超时。EventBus / Tree / Ledger
   *  本类不持有，留给 caller（Session）dispose。 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    await this.inSession(async () => {
      if (this.treeUnwatch) {
        this.treeUnwatch();
        this.treeUnwatch = null;
      }

      const shutdownPromises = [...this.agents.entries()].map(async ([id, agent]) => {
        try {
          if (this.onAgentDetached) {
            try { await this.onAgentDetached(id); } catch { /* ignore */ }
          }
          await agent.shutdown();
        } catch (err: any) {
          this._error(id, `shutdown agent failed: ${err?.message ?? err}`);
        }
      });

      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      await Promise.race([Promise.all(shutdownPromises), timeout]);

      this.agents.clear();
      this.started = false;
    });
  }

  // ─── Public control surface ──────────────────────────────────────────────

  getAgent(agentPath: string): BaseAgent | null {
    return this.agents.get(agentPath) ?? null;
  }

  /** Abort one or all agent loops（不 shutdown，仅触发当前 turn 的 abortController）。 */
  interruptAgents(agentPath?: string): void {
    if (agentPath) {
      const agent = this.agents.get(agentPath);
      if (agent) agent.stop();
    } else {
      for (const agent of this.agents.values()) agent.stop();
    }
  }

  async controlAgent(action: AgentControlAction, agentPath: string): Promise<string> {
    return this.inSession(() => {
      switch (action) {
        case "start":    return this.doStart(agentPath);
        case "shutdown": return this.doShutdown(agentPath);
        case "restart":  return this.doRestart(agentPath);
        case "remove":   return this.doRemove(agentPath);
      }
    });
  }

  // ─── Lifecycle helpers ───────────────────────────────────────────────────

  private async attachAndStart(agentPath: string): Promise<void> {
    try {
      await this.attachAgent(agentPath);
      await this.startAgent(agentPath);
    } catch (err: any) {
      this._error(agentPath, `attachAndStart failed: ${err?.message ?? err}`);
    }
  }

  private async doStart(agentPath: string): Promise<string> {
    return this.lifecycleLock.acquire(agentPath, async () => {
      if (this.agents.has(agentPath)) return `Agent '${agentPath}' is already running`;
      if (!this.tree.get(agentPath)) return `Agent '${agentPath}' tree node missing`;
      const agent = await this.agentFactory(agentPath);
      try {
        await agent.initKits();
      } catch (err: any) {
        this._error(agentPath, `initKits failed on doStart: ${err?.message ?? err}`);
      }
      this.agents.set(agentPath, agent);
      if (this.onAgentAttached) {
        try { await this.onAgentAttached(agent); }
        catch (err: any) {
          this._error(agentPath, `onAgentAttached on doStart failed: ${err?.message ?? err}`);
        }
      }
      this.runAgent(agentPath, agent);
      return `Agent '${agentPath}' started`;
    });
  }

  private async doShutdown(agentPath: string): Promise<string> {
    return this.lifecycleLock.acquire(agentPath, async () => {
      const agent = this.agents.get(agentPath);
      if (!agent) return `Unknown agent: '${agentPath}'`;
      await this.fireDetached(agentPath);
      await agent.shutdown();
      this.agents.delete(agentPath);
      return `Agent '${agentPath}' shut down`;
    });
  }

  private async doRestart(agentPath: string): Promise<string> {
    return this.lifecycleLock.acquire(agentPath, async () => {
      const agent = this.agents.get(agentPath);
      if (!agent) return `Unknown agent: '${agentPath}'`;
      await this.fireDetached(agentPath);
      await agent.shutdown();
      this.agents.delete(agentPath);
      const next = await this.agentFactory(agentPath);
      try {
        await next.initKits();
      } catch (err: any) {
        this._error(agentPath, `initKits failed on restart: ${err?.message ?? err}`);
      }
      this.agents.set(agentPath, next);
      if (this.onAgentAttached) {
        try { await this.onAgentAttached(next); }
        catch (err: any) {
          this._error(agentPath, `onAgentAttached on restart failed: ${err?.message ?? err}`);
        }
      }
      this.runAgent(agentPath, next);
      return `Agent '${agentPath}' restarted`;
    });
  }

  private async fireDetached(agentPath: string): Promise<void> {
    if (!this.onAgentDetached) return;
    try { await this.onAgentDetached(agentPath); }
    catch (err: any) {
      this._error(agentPath, `onAgentDetached failed: ${err?.message ?? err}`);
    }
  }

  /** shutdown + 触发外部清理（onAgentFreed）。
   *
   *  我们不在 Scheduler 这层删 agent.json / 清磁盘 —— 那是 Session 层的责任，由
   *  onAgentFreed 回调统一收口；Scheduler 只关心内存里的 agent 实例。 */
  private async doRemove(agentPath: string): Promise<string> {
    return this.lifecycleLock.acquire(agentPath, async () => {
      const agent = this.agents.get(agentPath);
      if (agent) {
        await this.fireDetached(agentPath);
        await agent.shutdown();
        this.agents.delete(agentPath);
      }
      const issues: string[] = [];
      if (this.onAgentFreed) {
        try { await this.onAgentFreed(agentPath); }
        catch (err: any) {
          const msg = err?.message ?? String(err);
          this._error(agentPath, `onAgentFreed failed: ${msg}`);
          issues.push(`onAgentFreed: ${msg}`);
        }
      }
      return issues.length === 0
        ? `Agent '${agentPath}' removed`
        : `Agent '${agentPath}' removed with issues: ${issues.join("; ")}`;
    });
  }

  /** Drive an agent's run loop on a fire-and-forget Promise；crash 走 lifecycleLock 清理。 */
  private runAgent(agentPath: string, agent: BaseAgent): void {
    // 双层 ALS：runWithSession 让 console.* 命中本 sid 的 session logger；
    // runWithAgentScope 再叠 agentId 让行 prefix 是 `[agentId#turn]`（ConsciousAgent
    // 内部的 runWithAgentTurn 会在每个 turn 继续 patch turn 字段，不覆盖 sid）。
    this.inSession(() => runWithAgentScope(agentPath, () => {
      agent.run(agent.signal)
        .catch((err) => {
          const msg = `agent loop crashed: ${(err as Error)?.message ?? err}`;
          // agent_crash 已经 publish 到 bus，会被 Session._bindLoggerBridge
          // 桥成 ERROR 行进 per-session logger，无需再 stderr.write。这里
          // 仅 logger.error 直接落一次（拿 logger 引用直接打也行，但 bus
          // event 自带 → log 是首选不变量）。
          agent.boundEventBus.publish({
            source: `agent:${agentPath}`,
            type: "agent_crash",
            ts: Date.now(),
            payload: { error: msg },
          });
          // crash 之后清掉它在 agents map 中的位置，但只有当 entry 仍是 crashed
          // 这个实例时才删 —— 否则可能误删 doRestart 之后顶上来的新实例。
          void this.lifecycleLock.acquire(agentPath, async () => {
            if (this.agents.get(agentPath) !== agent) return;
            await agent.shutdown();
            this.agents.delete(agentPath);
          }).catch(() => {});
        });
    }));
  }
}
