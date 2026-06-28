/** SessionManager —— 进程单例，管 `Map<sid, Session>` + LRU + autoStart 扫描。
 *
 *  与 agenteam ref 的差异（plan §3.1.1 / §3.1.2 / §4.x）：
 *  - **进程单例**：`initSessionManager(pm) / getSessionManager()`；多 cli attach 必
 *    须命中同一个 Session 实例（同一个 EventBus / Ledger）。
 *  - **不包 scheduler 启停**：`open()` 只 hydrate 内存态（构造 Session、扫 tree、
 *    回放 blackboard），不开火 scheduler；caller 自己决定 `s.scheduler.start()`。
 *  - **agent factory 在 SessionManager 这层装配**：把 ledger / sessionDefaultModels
 *    / kit （本轮空）注入打包，作为 SessionInitConfig.agentFactory 给 Session。
 *    ConsciousAgent 不直接被 Scheduler 依赖（plan §3.6）。
 *  - **create only builds an empty session container**: writes session.json +
 *    blackboard.json, never writes any agent.json. Agents are created via a separate
 *    path (spawn / hand-write agent.json); AgentTree only grows nodes when it sees
 *    agent.json. The agent's working directory is the session's `sessionWorkDir`
 *    (studio = its permanently-bound game dir), injected as `agentContext.cwd`.
 *  - **permanent binding (plan B PR2)**: a session is bound to its game at create
 *    time by the injected SessionLayout (path-as-SSOT). There is no `setDefaultDir`
 *    rebind and no stored `defaultDir` field — the bound slug is *derived* from the
 *    session's on-disk path (`basename(sessionWorkDir)`) and surfaced on the
 *    in-memory `config.defaultDir` for readers that still want the slug.
 *
 *  接口：create / open / close / delete / list / bootAutoStart。 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConsciousAgent } from "./conscious-agent";
import { Session } from "./session";
import { setSessionManager, peekSessionManager, clearSessionManager } from "./session-registry";
import type { AgentFactory } from "./scheduler";
import type { BaseAgent } from "./base-agent";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import { deepMerge } from "../utils/deep-merge";
import {
  Logger,
  setGlobalLogger,
  unsetGlobalLogger,
  registerSessionLogger,
  unregisterSessionLogger,
  attachConsoleEventEmitter,
  detachConsoleEventEmitter,
  getLogContext,
} from "./logger";
import type { AgentJson, ModelsConfig, SessionConfig } from "./types";
import type { PathManagerAPI } from "../fs/types";
import { createOrGetFSWatcher } from "../fs/watcher";
import { recoverAgentLedger } from "../ledger/ledger-recovery";

// create() only builds an empty session container (session.json +
// blackboard.json). The session's home + game binding are established by the
// injected SessionLayout via `paths.allocate(sid)` (studio = bind to the current
// active game, creating <games>/<slug>/sessions/<sid>/). The agent's cwd is the
// session's `sessionWorkDir` (the bound game dir). No symlink under session dir.

// ─── 类型 ───────────────────────────────────────────────────────────────

export interface CreateSessionOpts {
  displayName?: string;
  defaultModels?: ModelsConfig;
  timezone?: string;
  /** 缺省 true；显式 false 才跳过 boot autoStart。 */
  autoStart?: boolean;
}

export interface SessionListEntry {
  sid: string;
  displayName?: string;
  /** Bound game slug, derived from the session's path (may be undefined for a
   *  generic/unbound session). */
  defaultDir?: string;
  autoStart: boolean;
  /** Epoch ms of the session's last on-disk activity — newest mtime across
   *  the session's agents/ tree (where ledger / event jsonl land on each
   *  message), falling back to the session dir mtime when no events exist.
   *  Used by UIs to label / sort sessions by "最后对话时间". `undefined`
   *  when the session dir isn't stat'able. */
  lastActivityAt?: number;
}

/** Recursive scan of `dir` for the newest mtimeMs across every regular file
 *  reachable. Returns 0 when `dir` doesn't exist / is unreadable / is empty.
 *  Used by list() to derive a session's "last conversation time" from the
 *  newest jsonl write under its agents/ subtree. Defensive try/catch so a
 *  single unreadable entry doesn't poison the whole walk. */
function newestMtimeUnder(dir: string): number {
  let best = 0;
  if (!existsSync(dir)) return best;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && st.mtimeMs > best) best = st.mtimeMs;
        if (st.isDirectory()) {
          const sub = newestMtimeUnder(full);
          if (sub > best) best = sub;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir unreadable */ }
  return best;
}

// ─── 内部 LRU 简易实现 ──────────────────────────────────────────────────

class LRUList {
  private order: string[] = [];
  constructor(private readonly max: number) {}
  touch(sid: string): void {
    const idx = this.order.indexOf(sid);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(sid);
  }
  remove(sid: string): void {
    const idx = this.order.indexOf(sid);
    if (idx >= 0) this.order.splice(idx, 1);
  }
  /** Return list of victim sids（least-recent-first），按 max 决定淘汰几个。 */
  victimsBeyondLimit(currentSize: number): string[] {
    const overflow = currentSize - this.max;
    if (overflow <= 0) return [];
    return this.order.slice(0, overflow);
  }
}

// ─── SessionManager ─────────────────────────────────────────────────────

const DEFAULT_MAX_SESSIONS = 32;

export class SessionManager {
  private map = new Map<string, Session>();
  private lru: LRUList;
  /** SessionManager-singleton logger —— *只接收 session 元事件*（create / open /
   *  close / delete / boot autoStart / cross-session 操作）。落 `<userRoot>/debug.log`，
   *  不接收任何 agent turn / 模型消息（路由由 logger.ts 的 console bridge 完成）。
   *  per-Session 的 ledger / per-session logger 由 Session 自己持，互不交叉。 */
  readonly logger: Logger;

  /** SM 是否已经把 console bridge / emitter dispatcher 接上（process-singleton）。
   *  multi-SM 场景（test reset）下保证只挂一次，dispose 时统一 detach。 */
  private _consoleAttached = false;

  constructor(private readonly paths: PathManagerAPI, opts: { maxSessions?: number } = {}) {
    this.lru = new LRUList(opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.logger = new Logger({ debugLogPath: paths.user().debugLogFile() });

    // 把 SM.logger 钉成 globalLogger（sid 缺失时的 fallback），同时挂 emitter
    // dispatcher，让 `withModelFeedback(() => console.warn(...))` 真路由到对应
    // agent inbox。每个 Session 自己会再调 `registerSessionLogger(sid, ...)` 把
    // 自己的 logger 接入 router，那以后该 sid 的 console.* 自动落 session 文件。
    setGlobalLogger(this.logger);
    attachConsoleEventEmitter((agentId, level, msg, toAgent) =>
      this._dispatchConsoleEvent(agentId, level, msg, toAgent),
    );
    this._consoleAttached = true;
  }

  /** Emitter callback —— 把 console.warn/error 路由进 agent inbox / observers。
   *
   *  与旧版"线性扫 live sessions" 的差异：现在 logger bridge 把 sid 推进 ALS，
   *  这里**先**用 `getLogContext().sid` O(1) 拿 owner session；缺 sid 才 fallback
   *  到线性扫（多 session 同名 agent 取第一个命中，对齐 ref 单 instance 语义）。 */
  private _dispatchConsoleEvent(
    agentId: string,
    level: "warn" | "error",
    msg: string,
    toAgent: boolean,
  ): void {
    const payload = {
      content: msg,
      [level === "warn" ? "warning" : "error"]: msg,
    } as Record<string, string>;
    const event = {
      source: `agent:${agentId}`,
      type: "agent_log" as const,
      payload,
      ts: Date.now(),
    };

    const ctxSid = getLogContext().sid;
    const ordered: Session[] = ctxSid && this.map.has(ctxSid)
      ? [this.map.get(ctxSid) as Session, ...[...this.map.values()].filter((s) => s.sid !== ctxSid)]
      : [...this.map.values()];

    for (const session of ordered) {
      const agent = session.scheduler.getAgent(agentId);
      if (!agent) continue;
      if (toAgent) {
        // withModelFeedback：进 agent 自己 inbox，下一 turn 的 prompt 看得到。
        agent.boundEventBus.emitToSelf({ ...event, handoff: "silent" as const });
      } else {
        // 默认：publish 给 observers（UI / ledger / monitor），model 不看。
        // emitterId = agentId 让 per-agent observer（ledger persistence）能识别。
        session.eventBus.publish(event, agentId);
      }
      return;
    }
    // 没命中 owner session（boot / cross-session 操作）—— 噪声不进 inbox，
    // 只在 user-level debug.log 留痕（已经被 logger.warn/error 写过一次）。
  }

  // ─── create / open / close / delete ─────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const sid = randomUUID();
    // Establish the session's home + game binding (studio = current active game).
    // allocate is the single writer + creates the dir; path is the SSOT of the
    // binding afterward (no defaultDir persisted).
    const { workDir } = this.paths.allocate(sid);
    const layer = this.paths.session(sid);

    // 1) session.json —— **不**持久化 defaultDir(绑定由路径派生);只存稳定字段。
    const persisted = {
      displayName: opts.displayName,
      defaultModels: opts.defaultModels,
      timezone: opts.timezone,
      autoStart: opts.autoStart ?? true,
    };
    writeFileSync(layer.configFile(), JSON.stringify(persisted, null, 2) + "\n", "utf-8");

    // 2) blackboard.json（空）
    writeFileSync(join(layer.root(), "blackboard.json"), "{}\n", "utf-8");

    // 3) 内存态 Session —— config.defaultDir 派生自绑定 workDir(供 readers)。
    const config: SessionConfig = { ...persisted, defaultDir: basename(workDir) };
    const session = this._buildSession(sid, config);
    this.map.set(sid, session);
    this.lru.touch(sid);
    await this._evictIfNeeded();
    return session;
  }

  /** 只读取当前在内存里的 Session 实例，不触发 hydrate / LRU touch。
   *  cancel / status 类 API 用这个 —— 想 abort 一个根本没 open 的 session 没意义。 */
  peek(sid: string): Session | null {
    return this.map.get(sid) ?? null;
  }

  async open(sid: string): Promise<Session> {
    const cached = this.map.get(sid);
    if (cached) {
      this.lru.touch(sid);
      return cached;
    }
    const layer = this.paths.session(sid);
    if (!existsSync(layer.configFile())) {
      throw new Error(`SessionManager.open: session not found '${sid}'`);
    }
    const persisted = JSON.parse(readFileSync(layer.configFile(), "utf-8")) as SessionConfig;
    // defaultDir 派生自绑定路径(path-as-SSOT),不从盘读。
    const config: SessionConfig = { ...persisted, defaultDir: this._deriveSlug(sid) };
    const session = this._buildSession(sid, config);
    this.map.set(sid, session);
    this.lru.touch(sid);
    await this._evictIfNeeded();
    return session;
  }

  async close(sid: string): Promise<void> {
    const session = this.map.get(sid);
    if (!session) return;
    // **先**把 sid 从 map / lru 摘掉再 await dispose ——
    // 这样后续 open(sid) 立刻走 hydrate 路径，跟 LRU 软 close 语义一致；否则
    // dispose 期间 open 会拿到一个正在自毁的 Session 实例。
    this.map.delete(sid);
    this.lru.remove(sid);
    // 从 console bridge router 摘 session logger —— dispose 后期会 close 它，
    // 这里先反注册防止"刚 unregister 又被命中→写已关闭 stream"。残留的 in-flight
    // console.* 没命中 router → 自动 fallback 到 globalLogger（SM.logger），合理。
    unregisterSessionLogger(sid, session.logger);
    createOrGetFSWatcher().unregisterOwner(`session:${sid}`);
    await session.dispose();
  }

  async delete(sid: string): Promise<void> {
    await this.close(sid);
    const layer = this.paths.session(sid);
    if (existsSync(layer.root())) {
      rmSync(layer.root(), { recursive: true, force: true });
    }
  }

  list(): SessionListEntry[] {
    const out: SessionListEntry[] = [];
    // Enumeration goes through the active SessionLayout (generic = scan
    // <userRoot>/sessions; studio = its project-local layout), so list() never
    // assumes a single physical sessions root.
    const entries = this.paths.listSessionIds();

    for (const sid of entries) {
      const layer = this.paths.session(sid);
      if (!existsSync(layer.configFile())) continue;
      let cfg: SessionConfig;
      try { cfg = JSON.parse(readFileSync(layer.configFile(), "utf-8")) as SessionConfig; }
      catch { continue; }
      // Activity time: newest mtime under agents/ (where ledger + per-agent
      // jsonl event files land, so any message bump moves it forward); fall
      // back to session dir mtime when the agents tree is empty (= session
      // just created, no exchanges yet). Mirrors observatory.ts's
      // listSessionsWithMtime, but kept here so /api/sessions (single source
      // of truth for tabs) carries the field too — observatory remains its
      // own dashboard-focused view.
      const sessionDir = layer.root();
      let lastActivityAt: number | undefined;
      try {
        const agentsMtime = newestMtimeUnder(join(sessionDir, "agents"));
        if (agentsMtime > 0) {
          lastActivityAt = agentsMtime;
        } else {
          lastActivityAt = statSync(sessionDir).mtimeMs;
        }
      } catch { /* skip — leave undefined */ }
      out.push({
        sid,
        displayName: cfg.displayName,
        // 绑定 game slug 由路径派生(path-as-SSOT),不读盘上字段。
        defaultDir: this._deriveSlug(sid),
        autoStart: cfg.autoStart ?? true,
        lastActivityAt,
      });
    }
    return out;
  }

  /** 写前迁移(plan B PR2-compat):在对**老 session** 写新内容前调用。若该 sid 还在
   *  legacy 位置(pre-PR2 的 home/扁平),先 close(flush WAL + 释放句柄)再把整份目录 move
   *  进项目 `games/<slug>/sessions/<sid>/`,使新老记录都落当前项目。已在项目内 / generic
   *  layout / 非老 session → no-op。读路径不触发(只有写消息才迁移)。caller 随后正常 open。 */
  async prepareForWrite(sid: string): Promise<void> {
    if (!this.paths.isLegacySession(sid)) return; // 已项目本地 / 无 legacy 概念
    if (this.map.has(sid)) await this.close(sid); // 释放句柄后再搬目录
    this.paths.migrateLegacyIntoProject(sid);
  }

  /** Server boot 扫 sessions/，对 autoStart !== false 的全 open。caller 自己决定
   *  `s.scheduler.start()`（plan §4.5）。 */
  async bootAutoStart(): Promise<Session[]> {
    const opened: Session[] = [];
    for (const entry of this.list()) {
      if (!entry.autoStart) continue;
      try { opened.push(await this.open(entry.sid)); }
      catch (err: any) {
        process.stderr.write(`[session-manager] bootAutoStart skip ${entry.sid}: ${err?.message ?? err}\n`);
      }
    }
    return opened;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /** 装配 agent factory + 构造 Session。Factory 负责读 agent.json、调
   *  `session.getOrCreateLedger(agentPath)` 注入 ledger，构造 ConsciousAgent。 */
  private _buildSession(sid: string, config: SessionConfig): Session {
    let session!: Session;
    const factory: AgentFactory = async (agentPath: string): Promise<BaseAgent> => {
      const agentJson = await this._readAgentJson(sid, agentPath);
      const ledger = session.getOrCreateLedger(agentPath);

      // Recovery：reload / 崩溃重启后第一次 attach 时扫 ledger，把任何
      // 「hook:turnStart 没等到对应 turnEnd 就被掐断」的孤立 turn 补一条
      // 合成 turnEnd（aborted: true）。走 publish 不直接 append：
      //   - `_bindLedgerPersistence` observer 自动把它写到 WAL（避免双写）
      //   - WS hub observer 把这条 turnEnd 推给前端，前端 isStreaming 立刻清
      try {
        await recoverAgentLedger(
          agentPath,
          () => ledger.readAllEvents(),
          (ev) => session.eventBus.publish(ev, agentPath),
        );
      } catch (err: any) {
        session.logger.error(
          agentPath,
          undefined,
          `ledger recovery failed: ${err?.message ?? err}`,
        );
      }

      // Agent cwd = the session's bound working directory (studio = its game dir),
      // resolved from the injected SessionLayout (path-as-SSOT) — no stored slug.
      // Missing/invalid → undefined → agent falls back to agentDir. Never throw
      // here: that would kill agentFactory before ConsciousAgent ctor, leaving no
      // per-agent queue → user_input drops silently. Graceful Degradation: a
      // missing work dir must not brick the chat path; agentDir is a fine fallback.
      let sessionCwd: string | undefined;
      try {
        const workDir = this.paths.sessionWorkDir(sid);
        if (existsSync(workDir)) {
          sessionCwd = workDir;
        } else {
          session.logger.warn(
            agentPath,
            undefined,
            `session workDir "${workDir}" does not exist; falling back to agentDir`,
          );
        }
      } catch (err: any) {
        session.logger.warn(
          agentPath,
          undefined,
          `session workDir resolution failed (${err?.message ?? err}); falling back to agentDir`,
        );
      }

      return new ConsciousAgent({
        agentPath,
        sid,
        agentDir: this.paths.session(sid).agent(agentPath).root(),
        agentJson,
        eventBus: session.eventBus,
        blackboard: session.blackboard,
        tree: session.tree,
        ledger,
        sessionCwd,
        sessionDefaultModels: session.config.defaultModels,
        fsWatcher: createOrGetFSWatcher(),
        fileRecorder: {
          ledger: session.fileActivity,
          locks: session.fileLocks,
          /** EventBus 派 `file-activity:start` / `file-activity:done`，emitterId =
           *  agentPath，使 system-event-log filter（only emitterId == null）跳过
           *  这条事件 —— 它已经写到 file-activity.jsonl，再写一遍 global-events 就
           *  双倍噪声。observers（WsHub / ledger persistence）照常收到。 */
          emit: (record, kind) => {
            session.eventBus.publish(
              {
                source: `agent:${record.agentPath}`,
                type: `file-activity:${kind}` as const,
                payload: record as unknown as Record<string, unknown>,
                ts: record.ts,
              },
              record.agentPath,
            );
          },
        },
        // assemblePrompt / runToolBatch / getTools 不注入，走 BaseAgent kits
        // 子系统默认（ContextEngine + toolRegistry.list + tool-batch-runner）。
        //
        // refreshTools **被 override** —— 默认 `reloadKitKind("tools")` 只盲刷
        // 当前 agent 的 tools；这里换成 `kitReloadCoordinator.flushReloads()`，
        // 它会用 combined-hash 比对 4 层（builtin/user/session/agent）所有
        // tool+slot+plugin 文件，**只对真改动**的 kit 触发对应 agent 的 reload，
        // 顺带把 ScriptAgent src/index.ts hot-create / revival 也覆盖。这条
        // polling 路径是 ref 设计 fs.watch 不可靠时的 fallback，bun + node
        // 在 inotify race 上的差异都被它兜底。
        refreshTools: () => session.kitReloadCoordinator.flushReloads().then(() => undefined),
      });
    };
    session = new Session({
      sid,
      paths: this.paths,
      config,
      agentFactory: factory,
    });

    // 把 session.logger 接入 console bridge router —— 此后**在该 sid scope 下跑**
    // 的所有 console.* 都落 `<sid>/logs/debug.log` + latest.log。session.dispose
    // 里会反注册（见 close()）。
    registerSessionLogger(sid, session.logger);

    // Watch session.json for hot-reload of defaultModels / autoStart. defaultDir
    // is NOT persisted (permanent binding, derived from path) — preserve the
    // derived value across reloads so readers keep seeing the bound slug.
    const configFile = this.paths.session(sid).configFile();
    createOrGetFSWatcher().watchFile(configFile, () => {
      try {
        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as SessionConfig;
        session.config = { ...updated, defaultDir: session.config.defaultDir };
      } catch (err: any) {
        process.stderr.write(`[session-manager] session.json reload failed for '${sid}': ${err?.message ?? err}\n`);
      }
    }, { ownerId: `session:${sid}` });

    return session;
  }

  /** 派生绑定 game slug = basename(sessionWorkDir(sid))(path-as-SSOT)。防御性:
   *  layout 解析失败(非法 slug 等)→ undefined,绝不让 session open/list 崩。 */
  private _deriveSlug(sid: string): string | undefined {
    try { return basename(this.paths.sessionWorkDir(sid)); } catch { return undefined; }
  }

  /** 读 + AGENT_DEFAULTS deep-merge。文件缺失时返回空 merge（让 BaseAgent 走全默认）。 */
  private async _readAgentJson(sid: string, agentPath: string): Promise<AgentJson> {
    const file = this.paths.session(sid).agent(agentPath).agentJson();
    let raw: Record<string, unknown> = {};
    try {
      const txt = await readFile(file, "utf-8");
      raw = JSON.parse(txt) as Record<string, unknown>;
    } catch {
      // 缺文件 / 损坏 → 全默认
    }
    return deepMerge(
      AGENT_DEFAULTS as unknown as Record<string, unknown>,
      raw,
    ) as unknown as AgentJson;
  }

  /** 纯 LRU 末位淘汰 —— attach 状态由 caller 自行用 server 通信查（如 WsHub），
   *  SessionManager 不再持任何 client ref-count，以免凭空构造一个 attach 概念。
   *  close() 是软释放，被踢的 sid 在下一次 open() 时会从盘上 hydrate 回来。
   *  返回 Promise 让 caller 选择 await（create/open 内会 await，确保对外语义"调用结束 = 所有
   *  关联状态收敛"，避免 evict 的 close 拖后腿造成 watcher / FS 测试串扰）。 */
  private async _evictIfNeeded(): Promise<void> {
    const victims = this.lru.victimsBeyondLimit(this.map.size);
    await Promise.all(
      victims
        .filter((sid) => this.map.has(sid))
        .map((sid) => this.close(sid).catch(() => {})),
    );
  }

  /** Process shutdown —— close 全部 session + detach console bridge + close
   *  SM logger。等价 ref `Scheduler.destroyRuntime` 之外的 instance teardown
   *  那一层（forgeax 没 instance 概念，SM 就是顶层）。`main.ts` SIGINT/SIGTERM
   *  handler 应当调一次。 */
  async shutdown(): Promise<void> {
    const sids = [...this.map.keys()];
    await Promise.all(sids.map((sid) => this.close(sid).catch(() => {})));
    if (this._consoleAttached) {
      detachConsoleEventEmitter();
      unsetGlobalLogger(this.logger);
      this._consoleAttached = false;
    }
    await this.logger.close();
  }
}

// ─── 进程单例 ───────────────────────────────────────────────────────────

export function initSessionManager(paths: PathManagerAPI, opts?: { maxSessions?: number }): SessionManager {
  const sm = new SessionManager(paths, opts);
  setSessionManager(sm);
  return sm;
}

// 单例访问器 `getSessionManager` 已下沉到 `./session-registry`(断开 kernel→core 环);
// 这里 re-export 给既有消费者,故调用点零改。
export { getSessionManager } from "./session-registry";

/** Test-only —— dispose all live sessions then drop the singleton。**必须**
 *  dispose 干净，否则 leak 的 FSWatcher / chokidar / coordinator slots 会跨
 *  test 串扰（特别是 fs.watch 路径在 bun 上 slot 累积时会让 inotify 派发
 *  延迟陡增，下一个 test 1s 内拿不到 addDir → flaky scaffold/kits）。 */
export async function resetSessionManager(): Promise<void> {
  const inst = peekSessionManager();
  if (inst) {
    clearSessionManager();
    await inst.shutdown();
  }
}
