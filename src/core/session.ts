/** Session —— per-sid 容器：bus / queue / blackboard / tree / ledgers / scheduler 全在内。
 *
 *  与 agenteam ref 的差异（plan §2.0 / §2.1 / §3.1.1）：
 *  - forgeax 的 sid 对应**一整棵 agent tree**（root + 所有 sub-agent）。一棵树一份
 *    ledger map（per-agent），一份 blackboard、一份 EventBus、一份 Scheduler。
 *  - **Session 不包 start/stop**：调度由 caller 直接 `session.scheduler.start() /
 *    .shutdown()`。`Session.dispose()` 只做容器层资源释放。
 *  - **abort 路径 = Scheduler，不放 Session**：cancel 由 caller 走
 *    `session.scheduler.interruptAgents(agentPath?)` 派给 per-agent `BaseAgent.stop()`
 *    （= `abortController.abort()`），与 agenteam ref `core/scheduler.interruptAgents`
 *    一致。Session 自身不持 AbortController。
 *  - **不维护 client attach 计数**：哪个 ws 连着哪个 sid 由外层（WsHub / 单独 status
 *    API）查；Session 不背任何 ref-count，订阅直接 `session.eventBus.observe(handler)`。
 *  - **sandbox 不挂 Session**：由 SandboxManager 按 `defaultDir` 池化共享，first
 *    tool exec 时 lazy acquire，与 Session 解耦。
 *  - **agentFactory** 是 caller（SessionManager）注入的 callback：Scheduler 通过它
 *    为每个 agentPath 构造 ConsciousAgent 实例（包含 ledger / sessionDefaultModels
 *    注入），Session 自己只负责管 ledger map + 资源回收。
 *
 *  字段（plan §2.1）：
 *  - sid / paths / config / blackboard / eventBus / scheduler / tree / ledgers → dispose */

import { Blackboard } from "./blackboard";
import { EventBus } from "./event-bus";
import { AgentTree } from "./agent-tree";
import { Scheduler, type AgentFactory } from "./scheduler";
import { EventLedger } from "../ledger/event-ledger";
import { FileActivityLedger } from "../ledger/file-activity-ledger";
import type { FileLockMap } from "../fs/agent-fs-recorder";
import { bindSystemEventLog } from "../ledger/system-event-log";
import { Logger } from "./logger";
import type { SessionConfig } from "./types";
import type { PathManagerAPI, SessionLayerAPI } from "../fs/types";
import { createOrGetFSWatcher } from "../fs/watcher";
import { AgentKitReloadCoordinator } from "../kits/reload-coordinator";
import { clearRememberedForSession } from "../kernel/tool-approval";

/** One pending delegate_to_subagent awaiting the sub-agent's turn-end.
 *  Keyed by sub-agent's `agentPath` (e.g. "suzu"). */
export interface DelegationInfo {
  /** The agent that called delegate_to_subagent (e.g. "forge"). */
  delegator: string;
  /** First ~80 chars of the brief, for the callback message. */
  brief: string;
  /** ms — used to GC stale entries if turn-end never fires. */
  ts: number;
}

export interface SessionInitConfig {
  sid: string;
  paths: PathManagerAPI;
  config: SessionConfig;
  /** Caller 提供的 agent factory —— Scheduler attach 一个新 agentPath 时调它构造
   *  BaseAgent 实例（注入 ledger / kit / models）。SessionManager 在构造 Session
   *  时把它包出来，避免 Session 反向依赖 ConsciousAgent。 */
  agentFactory: AgentFactory;
  /** Optional: agent 被 `controlAgent("remove", path)` 摘掉后的清理钩子
   *  （wipe blackboard 命名空间 / dispose ledger）。SessionManager 默认
   *  包出 `(agentPath) => session.freeAgentState(agentPath)`。 */
  onAgentFreed?: (agentPath: string) => void | Promise<void>;
}

/** Pull plain text out of a `hook:assistantMessage` payload. The assistant
 *  message lives at `payload.llmMessage.content`, which is either a string or
 *  an array of content blocks; we concatenate the `text` blocks (thinking /
 *  tool_use blocks are skipped — the delegator wants the report, not internals). */
function extractAssistantText(payload: unknown): string {
  const msg = (payload as { llmMessage?: { content?: unknown } } | undefined)?.llmMessage;
  const content = msg?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "";
}

export class Session {
  readonly sid: string;
  readonly paths: SessionLayerAPI;
  config: SessionConfig;

  readonly blackboard: Blackboard;
  readonly eventBus: EventBus;
  readonly tree: AgentTree;
  readonly scheduler: Scheduler;

  /** Kit hot-reload dispatcher（B1.11）：
   *  - fs.watch builtin/user/session 3 共享层 + per-agent 那一层 kits/
   *  - per-tool-batch poll baseline（ConsciousAgent.refreshTools 默认绑到这里）
   *  - ScriptAgent src/index.ts 改动 → 走 `scheduler.controlAgent("restart", path)`
   *
   *  bun / node fs.watch 在 Linux 上 inotify 路径基本一致，但 bun 对
   *  `O_TRUNC + write + close` 的 add 事件偶尔会漏；这正是 ref 设计 polling
   *  fallback 的原因 —— ConsciousAgent 每个 tool batch 之后调一次 flushReloads
   *  作为可靠路径，fs.watch 只是事件驱动的加速。 */
  readonly kitReloadCoordinator: AgentKitReloadCoordinator;

  /** Per-Session logger —— 落到 `<sid>/logs/debug.log` 全量 + `<sid>/logs/latest.log`
   *  INFO+。覆盖：Session plumbing 错误 / EventBus → log 桥 / agent plumbing
   *  事件。跟 EventLedger 是两条不同的轨：ledger 是 LLM context 真相，logger
   *  是运维 / 观测真相。 */
  readonly logger: Logger;

  /** Per-agent ledgers —— scheduler 通过 agentFactory 构造 ConsciousAgent 时
   *  从这里取出 ledger 喂给 ContextWindow。 */
  readonly ledgers = new Map<string, EventLedger>();

  /** Per-session **file-activity** ledger —— SSOT for "who touched what".
   *  Wired into BaseAgent ctor: every wrapped `ctx.fs` mutation appends one
   *  record here (via `wrapAgentFsWithRecorder`). UI / LLM slot / REST all
   *  derive from this one ledger; no agent owns/persists its own file list.
   *  See [[file-activity-tracking]] design notes in the recorder module. */
  readonly fileActivity: FileActivityLedger;

  /** In-memory cross-agent file-edit lock map. `Map<absPath, {agentPath, op,
   *  since}>`. Held only for the duration of a recorder-wrapped write —
   *  never persisted (process death = locks cleared). Cross-agent visible
   *  via `/api/sessions/:sid/file-locks`. */
  readonly fileLocks: FileLockMap = new Map();

  /** Pending delegations awaiting a completion-callback. Populated by the
   *  `delegate_to_subagent` tool when the delegator hands a task to a
   *  teammate; consumed by `_bindDelegationCallback` when the teammate
   *  emits `hook:turnEnd`. Without this map the delegator never learns
   *  the sub-agent finished — fire-and-forget by design pre-2026-05-28,
   *  user complained "主 agent 不知道". Mirrors agentic_os's MessageBus
   *  auto-deliver pattern (sub-agent → parent on turn-end). */
  readonly delegations = new Map<string, DelegationInfo>();

  /** Latest assistant text per agentPath, captured live off the EventBus.
   *  Consumed by `_bindDelegationCallback` so the completion message carries
   *  the teammate's ACTUAL output (e.g. tsumugi's verify report), not just a
   *  "done" notice. Without this the delegator knew the sub-agent finished but
   *  not WHAT it produced, so it stalled asking the user to paste the result
   *  back across chat tabs — the root of the "做一点就停/反复说继续" loop. */
  private readonly latestAssistantText = new Map<string, string>();

  private disposed = false;

  constructor(private readonly init: SessionInitConfig) {
    this.sid = init.sid;
    this.paths = init.paths.session(init.sid);
    this.config = init.config;

    this.blackboard = new Blackboard(this.paths.root() + "/blackboard.json");
    this.blackboard.loadFromDisk();

    this.fileActivity = new FileActivityLedger(this.paths.root(), this.paths.fileActivityLog());

    this.logger = new Logger({
      debugLogPath: this.paths.debugLogFile(),
      latestLogPath: this.paths.latestLogFile(),
    });

    this.eventBus = new EventBus();
    this.tree = new AgentTree(init.sid, init.paths);
    this.tree.init();

    // 注意构造顺序：scheduler hooks 通过 `this.kitReloadCoordinator` 间接访问，
    // 闭包延迟解引用 —— 把 coordinator 放在 scheduler **之后**构造也行，因为
    // scheduler.attachAgent 是 async，第一次 attach 时 coordinator 已就位。
    this.scheduler = new Scheduler({
      sid: this.sid,
      eventBus: this.eventBus,
      tree: this.tree,
      agentFactory: init.agentFactory,
      logger: this.logger,
      onAgentFreed: init.onAgentFreed ?? ((agentPath) => this.freeAgentState(agentPath)),
      onAgentAttached: (agent) => this.kitReloadCoordinator?.registerAgent(agent),
      onAgentDetached: (agentPath) => this.kitReloadCoordinator?.unregisterAgent(agentPath),
    });

    this.kitReloadCoordinator = new AgentKitReloadCoordinator(
      this.sid,
      createOrGetFSWatcher(),
      init.paths,
      () => this.tree.list().map((n) => n.path),
      async (agentPath) => {
        // scheduler.controlAgent("restart") 拿 lifecycleLock，确保和正在 run
        // 的 turn 串行。返回值字符串无所谓——只要它真跑完算 handled，让
        // coordinator 推进 src baseline。busy 时 lifecycleLock 会让它排队等
        // 而不是立刻返回 false，所以这里返回 true 即可。
        try {
          await this.scheduler.controlAgent("restart", agentPath);
          return true;
        } catch (err: any) {
          this.logger.error(agentPath, undefined, `scriptSrcChanged restart failed: ${err?.message ?? err}`);
          return false;
        }
      },
    );
    // **不**主动 startWatching —— coordinator 自己在第一次 registerAgent
    // 时 lazy-boot 共享层 fs.watch（参考 ref：scheduler.start() 才起）。
    // 这样纯 container session（不 attachAgent 的 bus/scaffold/LRU 用例）
    // 不占任何 inotify slot，避免 bun 上 slot 累积引起的 fs 事件派发劣化。

    // 三条独立 observer：
    //   1) per-agent ledger persistence（对齐 ref `_bindEventBus`）—— 把跟某 agent
    //      关联的事件落到该 agent 的 events.jsonl。
    //   2) `agent_command` routing（对齐 ref `attachSchedulerListeners`）—— UI / CLI
    //      / 其他 agent 在总线上发 `{type:"agent_command", to:agentPath, payload:
    //      {toolName, args}}` 时，桥到目标 ConsciousAgent.queueCommand，让对方在
    //      下一 turn 把它合成 user-issued tool_call 进 LLM 历史。
    //   3) per-session "headless" event log（对齐 ref `system-event-log`）——
    //      没 owner、没 to 的事件（agent_added/removed、default_dir_changed、
    //      partial_boundary、compact_boundary 等）落到 `<sid>/global-events.jsonl`。
    // 顺序无关；dispose 时按注册逆序 unsub。
    this._busUnsubs = [
      this._bindLedgerPersistence(),
      this._bindAgentCommandRouting(),
      this._bindDelegationCallback(),
      bindSystemEventLog(this.paths.globalEventsLog(), this.eventBus),
    ];
  }

  // ─── delegate_to_subagent → auto-completion-callback ─────────────────────

  /** When a teammate that the delegator handed work to via
   *  `delegate_to_subagent` finishes its turn, push a `message` back to the
   *  delegator so it can react in its next turn — agentic_os MessageBus
   *  auto-deliver pattern (sub-agent → parent on turn-end). Without this the
   *  delegator never learns the sub-agent finished; user complaint
   *  "主 agent 不知道". The pending entry is created by the tool and consumed
   *  here on the first `hook:turnEnd` emitted by the sub-agent. */
  private _bindDelegationCallback(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (!emitterId) return;

      // Capture every agent's latest assistant text so a completion callback
      // can relay the teammate's actual output (not just "done"). Cheap string
      // write per turn; kept for all agents since `delegations` membership can
      // change between the message and turn-end.
      if (event.type === "hook:assistantMessage") {
        const text = extractAssistantText(event.payload);
        if (text) this.latestAssistantText.set(emitterId, text);
        return;
      }

      if (event.type !== "hook:turnEnd") return;
      const info = this.delegations.get(emitterId);
      if (!info) return;
      this.delegations.delete(emitterId);
      const payload = (event.payload ?? {}) as { aborted?: boolean; error?: string; stopReason?: string };
      const status = payload.aborted ? "取消" : payload.error ? "失败" : "完成";
      const detail = payload.error ? `（错误：${String(payload.error).slice(0, 120)}）` : "";
      // Relay the teammate's actual final output so the delegator can act on it
      // directly (e.g. apply tsumugi's verify report) instead of stalling to
      // ask the user to paste it back. Trim to keep the delegator's context
      // bounded; the full transcript still lives in the teammate's ledger.
      const result = payload.aborted ? "" : (this.latestAssistantText.get(emitterId) ?? "");
      this.latestAssistantText.delete(emitterId);
      const MAX = 8000;
      const resultBlock = result
        ? `\n\n--- ${emitterId} 的产出 ---\n${result.length > MAX ? result.slice(0, MAX) + "\n…（已截断，完整内容见该 agent 的对话）" : result}`
        : "";
      // emit (not publish) — `to` routes the event into the delegator's
      // per-agent queue. Without queue routing the delegator's run-loop
      // (waitForEvent → drainQueue) never wakes and the message is lost.
      this.eventBus.emit(
        {
          source: "agent",
          type: "message",
          payload: {
            content: `✓ ${emitterId} ${status}了你交办的任务${detail}：${info.brief}${resultBlock}`,
            fromAgent: emitterId,
          },
          to: info.delegator,
          handoff: "turn",
          ts: Date.now(),
        },
        emitterId,
      );
    });
  }

  // ─── EventBus → agent_command routing ────────────────────────────────────

  /** 镜像 agenteam ref `attachSchedulerListeners`：观察总线上的 `agent_command`
   *  事件，把它桥到 `scheduler.getAgent(to).queueCommand(...)`。target 优先取
   *  `event.to`，缺省回退到 `payload.agentId` —— UI 发的事件通常用 payload.agentId
   *  避免触发 EventBus.route() 的 inbound message 路径（payload 模式是纯 metadata
   *  容器，不会被 route() 转发到目标 queue）。
   *
   *  duck-type 检查 `queueCommand` 函数存在 —— Session 不 import ConsciousAgent
   *  类型（plan §3.6：Session 不反向依赖 conscious-agent.ts），让 ScriptAgent /
   *  BaseAgent 静默 ignore 这种事件。 */
  private _bindAgentCommandRouting(): () => void {
    return this.eventBus.observe((event) => {
      if (event.type !== "agent_command") return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const targetPath =
        (event.to as string | undefined) ?? (payload.agentId as string | undefined);
      if (!targetPath) return;
      const agent = this.scheduler.getAgent(targetPath);
      if (!agent) return;
      const handler = (agent as unknown as { queueCommand?: unknown }).queueCommand;
      if (typeof handler !== "function") return;       // ScriptAgent etc.
      const toolName = payload.toolName as string | undefined;
      if (!toolName) return;
      const args = (payload.args as Record<string, string> | undefined) ?? {};
      const reason = (payload.reason as string | undefined) ?? undefined;
      const interrupt = (payload.interrupt as boolean | undefined) ?? true;
      try {
        (handler as (
          n: string,
          a: Record<string, string>,
          r: string | undefined,
          i: boolean,
        ) => void).call(agent, toolName, args, reason, interrupt);
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        this.logger.error(
          targetPath,
          undefined,
          `agent_command queueCommand "${toolName}" failed: ${msg}`,
        );
      }
    });
  }

  private readonly _busUnsubs: Array<() => void>;

  // ─── EventBus → ledger persistence ───────────────────────────────────────

  /** 镜像 agenteam ref `session-manager._bindEventBus`：所有跟某个 agent 关联的
   *  event（emitterId === agent || event.to === agent）落到该 agent 的 ledger。
   *  stream chunk 类高频事件（type 以 `stream:` 开头）跳过。同步写盘（不 defer）确保
   *  buildPrompt 在同一 async tick 内读到当前 turn 的 inbound_message。 */
  private _bindLedgerPersistence(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (event.type.startsWith("stream:")) return;
      // file-activity:* 是给 UI / file-activity-ledger 的信号事件，不是对话事件 ——
      // 已经写入 `<sid>/file-activity.jsonl`，再写一份到 per-agent EventLedger 只
      // 是双倍噪声 + LLM 历史污染。用专门的 LLM slot（file-activity-recent）按需
      // 注入，比每个 write 自动塞 prompt 更可控。
      if (event.type.startsWith("file-activity:")) return;

      const candidates: string[] = [];
      if (emitterId && this.tree.get(emitterId)) candidates.push(emitterId);
      if (event.to && event.to !== "*" && event.to !== emitterId && this.tree.get(event.to as string)) {
        candidates.push(event.to as string);
      }
      if (candidates.length === 0) return;

      if (this.disposed) return;
      if (event.to && event.isBlocked?.()) return;
      for (const agentPath of candidates) {
        try {
          this.getOrCreateLedger(agentPath).append(event, emitterId);
        } catch (err) {
          const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
          this.logger.error(agentPath, undefined, `WAL append "${event.type}" failed: ${msg}`);
        }
      }
    });
  }

  // ─── Per-agent ledger lookup ─────────────────────────────────────────────

  /** Lazy-init per-agent ledger。SessionManager / agentFactory 可以提前 prime。 */
  getOrCreateLedger(agentPath: string): EventLedger {
    let ledger = this.ledgers.get(agentPath);
    if (!ledger) {
      ledger = new EventLedger(this.sid, agentPath, this.init.paths);
      this.ledgers.set(agentPath, ledger);
    }
    return ledger;
  }

  // ─── External-state cleanup hook for Scheduler ───────────────────────────

  /** Called by Scheduler.controlAgent("remove") via onAgentFreed callback. Wipes
   *  the agent's blackboard namespace + drops its ledger from the map. We do NOT
   *  rm the agent dir / ledger file —— that belongs to a future fs-mutation
   *  command path（`destroy_subagent`）, not Scheduler's lifecycle removal. */
  freeAgentState(agentPath: string): void {
    this.blackboard.removeAll(agentPath);
    this.ledgers.delete(agentPath);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Soft dispose —— SessionManager.close 调，**不**删盘。
   *
   *  顺序对齐 ref `Scheduler.destroyRuntime`（agenteam-os-ref scheduler.ts:470）：
   *    1. _busUnsub                    ← 先停 ledger persistence observer
   *    2. scheduler.shutdown()         ← ref `shutdownAll`，等 agents 全停
   *    3. kitReloadCoordinator.stopWatching()
   *    4. tree.dispose()               ← ref `agentTree.stopWatching`
   *    5. blackboard.flush() + ledgers.clear()
   *    6. logger.close()               ← ref destroyRuntime 最后一步
   *
   *  注意：console emitter 在 SessionManager 级 attach（process-singleton），
   *  SM 关 last session 时统一 `detachConsoleEventEmitter`；Session 自己不动
   *  全局 console bridge，避免抢其他 live session 的 slot。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = this._busUnsubs.length - 1; i >= 0; i--) this._busUnsubs[i]();
    await this.scheduler.shutdown();
    this.kitReloadCoordinator.stopWatching();
    await this.tree.dispose();
    this.blackboard.flush();
    this.ledgers.clear();
    this.fileActivity.dispose();
    this.fileLocks.clear();
    clearRememberedForSession(this.sid); // 清本会话的工具审批 remember(不跨会话残留)
    await this.logger.close();
  }
}
