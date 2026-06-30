/** Logger —— sid-routed console bridge + per-Session file logger + feedback emitter。
 *
 *  跟 ref `agenteam-os-ref/src/core/logger.ts`（342 行）的关系：
 *
 *  - **同款移植**：`installConsoleBridge` / `attachConsoleLogger` /
 *    `detachConsoleLogger` / `getConsoleLogger` / `forwardToOriginalConsole` /
 *    `attachConsoleEventEmitter` / `detachConsoleEventEmitter` /
 *    `withModelFeedback` / `runWithAgentTurn` / `runWithAgentScope` /
 *    `bindAgentScope` / 50MB rotate × 5 / LogLevel / formatLine。
 *
 *  - **多 Logger 的关键差异**：ref `Logger` 单实例持 `globalDebugStream` + per-agent
 *    `AgentFileLogger` 双轨写；forgeax 多 session ⇒ **多 Logger 实例**，由 console
 *    bridge 充当 router。设计契约（用户钉死，2026-05-20）：
 *
 *      - **用户级 debug.log** 只记录 *session 层次* 的事件（create / open / close /
 *        delete / boot / cross-session 操作 / autoStart 失败等 SM plumbing），
 *        不接收任何 agent turn / 模型消息。
 *      - **session 级 debug.log + latest.log** 落该 session 下所有日志（agent turn /
 *        kits / scheduler plumbing / event-bus → log 桥）。
 *      - 调用方视角透明：**仍然写 `console.log(...)`**，bridge 按 ALS `LogContext.sid`
 *        自动路由（命中 → 写对应 session logger；缺失 → 落 globalLogger 兜底）。
 *
 *  - **路由实现**：`setGlobalLogger(SM.logger)` + 每个 Session 构造时
 *    `registerSessionLogger(sid, session.logger)` / dispose 时 `unregister`。
 *    `Scheduler.runAgent` 把 agent.run 包在 `runWithSession(sid, runWithAgentScope(...))`
 *    里，让 agent 栈内所有 `console.*` 自动带 sid。
 *
 *  - **emitter dispatcher**：ref `attachConsoleEventEmitter` 在 `Scheduler.start`
 *    挂一次（单 instance）；forgeax 在 `SessionManager` 启动时挂一次 dispatcher，
 *    dispatcher 按 ALS sid（O(1)）找 session，再按 agentId 找 agent。emitter callback
 *    签名跟 ref 同 `(agentId, level, msg, toAgent)`。
 *
 *  落点（实际写盘）：
 *  - `<userRoot>/debug.log`：SM.logger —— *仅 session 元事件*。
 *  - `<sid>/logs/debug.log` + `<sid>/logs/latest.log`：per-Session logger —— *该 sid
 *    范围内所有日志*（含 agent / kits / scheduler / event-bus 桥）。 */

import { createWriteStream, statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { formatWithOptions } from "node:util";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO ",
  [LogLevel.WARN]: "WARN ",
  [LogLevel.ERROR]: "ERROR",
};

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ROTATIONS = 5;

function rotateLogFile(filePath: string): WriteStream {
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
  return createWriteStream(filePath, { flags: "a" });
}

// ─── LogContext (AsyncLocalStorage) ──────────────────────────────────────────

export interface LogContext {
  /** 全写 = `agents/` 下的相对路径（root、iori、iori/agents/suzu），来源**唯一**。
   *  特殊值：`system`（boot / 跨 session 操作） / `gateway`（forwardToOriginalConsole）。 */
  agentId: string;
  /** 该 agent 当前 turn（仅 ConsciousAgent.runMain 内有）。 */
  turn?: number;
  /** 当前归属的 Session sid —— bridge 据此路由 console.* 到对应 session logger。
   *  缺失时 fallback 到 globalLogger（SM.logger）。Scheduler.runAgent + lifecycle
   *  helpers 在外层包 `runWithSession(sid, ...)`，使 agent 栈内 console.* 自动带
   *  sid；SM 自身的 create / open / close / boot 操作**不**进 session scope，
   *  所以那些 console.* 落 user-root debug.log。 */
  sid?: string;
}

const DEFAULT_LOG_CONTEXT: LogContext = { agentId: "system" };
const logContextStorage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? consoleBridgeState.defaultContext;
}

/** 进 session scope —— 把 sid 推到 ALS。Scheduler.runAgent / lifecycle helpers
 *  外层套这个，让该栈内任何 `console.*` / `runWithAgentScope` / `runWithAgentTurn`
 *  自动继承 sid，bridge 路由到 `<sid>/logs/debug.log`。`runWithAgentScope` 和
 *  `runWithAgentTurn` 都做**继承式**合并（prev sid 不被覆盖），所以嵌套套用
 *  顺序为 `runWithSession → runWithAgentScope → runWithAgentTurn`。 */
export function runWithSession<T>(sid: string, fn: () => T): T {
  const prev = logContextStorage.getStore();
  return logContextStorage.run({ ...(prev ?? DEFAULT_LOG_CONTEXT), sid }, fn);
}

/** 进 agent scope 带 turn（ConsciousAgent.runMain 包整 turn）。继承上层 sid。 */
export function runWithAgentTurn<T>(agentId: string, turn: number, fn: () => T): T {
  const prev = logContextStorage.getStore();
  return logContextStorage.run({ ...(prev ?? DEFAULT_LOG_CONTEXT), agentId, turn }, fn);
}

/** 进 agent scope 不带 turn（loading / daemon callback / background）。继承上层 sid。 */
export function runWithAgentScope<T>(agentId: string, fn: () => T): T {
  const prev = logContextStorage.getStore();
  // 清掉上层 turn（不同 agent 的 turn 计数不一致），sid 保留。
  return logContextStorage.run({ ...(prev ?? DEFAULT_LOG_CONTEXT), agentId, turn: undefined }, fn);
}

/** 把 agent scope 绑到回调 —— observe / setTimeout / fs.watch handler
 *  这些会逃逸 AsyncLocalStorage 的场景必须包。 */
export function bindAgentScope<TArgs extends unknown[], TResult>(
  agentId: string,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => runWithAgentScope(agentId, () => fn(...args));
}

/** 把 session scope 绑到回调 —— fs watcher / setTimeout 等 escape ALS 场景。 */
export function bindSessionScope<TArgs extends unknown[], TResult>(
  sid: string,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => runWithSession(sid, () => fn(...args));
}

// ─── console bridge ──────────────────────────────────────────────────────────

type ConsoleMethod = "debug" | "log" | "info" | "warn" | "error";
type ConsoleFn = (...args: unknown[]) => void;

const CONSOLE_METHODS: ConsoleMethod[] = ["debug", "log", "info", "warn", "error"];

const consoleBridgeState: {
  installed: boolean;
  /** SM 单例 logger —— sid 没命中 router 时 fallback。覆盖：
   *  - boot 阶段（SM 还没 register session 前）
   *  - cross-session 操作（SM 自身的 create / open / close / list）
   *  - 找不到 owner session 的孤儿 console.*。 */
  globalLogger: Logger | null;
  /** sid → per-session logger 路由表。`registerSessionLogger` 写、
   *  `unregisterSessionLogger` 摘；Session ctor / dispose 各调一次。 */
  sessionLoggers: Map<string, Logger>;
  defaultContext: LogContext;
  originals: Partial<Record<ConsoleMethod, ConsoleFn>>;
  emit?: (agentId: string, level: "warn" | "error", msg: string, toAgent: boolean) => void;
  emitToAgent: boolean;
} = {
  installed: false,
  globalLogger: null,
  sessionLoggers: new Map(),
  defaultContext: DEFAULT_LOG_CONTEXT,
  originals: {},
  emitToAgent: false,
};

/** Pick the logger that should receive a console.* call given current ALS sid.
 *  缺 sid / sid 未注册 / globalLogger 都没设 → 返 null（caller fallback 到 stderr）。 */
function pickLoggerFor(sid: string | undefined): Logger | null {
  if (sid) {
    const session = consoleBridgeState.sessionLoggers.get(sid);
    if (session) return session;
  }
  return consoleBridgeState.globalLogger;
}

function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return formatWithOptions({ colors: false, depth: 6 }, ...args);
}

const L0_LEVEL: Record<ConsoleMethod, string> = {
  debug: "DEBUG",
  log: "INFO ",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function forwardToOriginalConsole(method: ConsoleMethod, args: unknown[]): void {
  const msg = formatConsoleArgs(args);
  const line = `[${ts()}] [${L0_LEVEL[method]}] [gateway] ${msg}\n`;
  process.stderr.write(line);
}

/** 劫持 5 个 console 方法 —— 每次调用按当前 ALS LogContext 路由：
 *    - `sid` 命中 sessionLoggers → 写该 session logger（`<sid>/logs/debug.log`
 *      + `latest.log`）
 *    - 否则 fallback 到 globalLogger（SM.logger → user-root debug.log）
 *    - 都没 → forwardToOriginalConsole (stderr)
 *  幂等，重复调用 noop。 */
export function installConsoleBridge(): void {
  if (consoleBridgeState.installed) return;

  for (const method of CONSOLE_METHODS) {
    consoleBridgeState.originals[method] = console[method].bind(console) as ConsoleFn;
    console[method] = ((...args: unknown[]) => {
      const ctx = getLogContext();
      const logger = pickLoggerFor(ctx.sid);
      if (!logger) {
        forwardToOriginalConsole(method, args);
        return;
      }

      const msg = formatConsoleArgs(args);
      const { agentId, turn } = ctx;

      switch (method) {
        case "debug":
          logger.debug(agentId, turn, msg);
          break;
        case "log":
        case "info":
          logger.info(agentId, turn, msg);
          break;
        case "warn":
          logger.warn(agentId, turn, msg);
          consoleBridgeState.emit?.(agentId, "warn", msg, consoleBridgeState.emitToAgent);
          break;
        case "error":
          logger.error(agentId, turn, msg);
          consoleBridgeState.emit?.(agentId, "error", msg, consoleBridgeState.emitToAgent);
          break;
      }
    }) as ConsoleFn;
  }

  consoleBridgeState.installed = true;
}

/** 设 sid 缺失时的 fallback logger —— SessionManager 启动一次。多次调用最后一次胜出。
 *
 *  与 ref `attachConsoleLogger` 的语义差异：ref 是"全局唯一接收方"，**所有**
 *  console.* 都进这一份；forgeax 用 sid router 分流，这里只承接 sid 未命中
 *  的孤儿（boot / cross-session 操作）。 */
export function setGlobalLogger(logger: Logger, opts?: { agentId?: string; turn?: number }): void {
  installConsoleBridge();
  consoleBridgeState.globalLogger = logger;
  consoleBridgeState.defaultContext = {
    agentId: opts?.agentId ?? DEFAULT_LOG_CONTEXT.agentId,
    ...(opts?.turn !== undefined ? { turn: opts.turn } : {}),
  };
}

/** 反注册 globalLogger（若传 logger 且不是当前那个则 no-op）。 */
export function unsetGlobalLogger(logger?: Logger): void {
  if (!logger || consoleBridgeState.globalLogger === logger) {
    consoleBridgeState.globalLogger = null;
  }
}

/** 注册一个 session 的 logger 到 router —— Session ctor 调一次。
 *  duplicate sid 不报错，后者覆盖前者（test reset / hot-reload 场景）。 */
export function registerSessionLogger(sid: string, logger: Logger): void {
  installConsoleBridge();
  consoleBridgeState.sessionLoggers.set(sid, logger);
}

/** 反注册 sid 的 logger —— Session.dispose 调。 */
export function unregisterSessionLogger(sid: string, logger?: Logger): void {
  if (logger && consoleBridgeState.sessionLoggers.get(sid) !== logger) return;
  consoleBridgeState.sessionLoggers.delete(sid);
}

/** Test/diagnostic —— 当前 router 的快照。 */
export function getConsoleRouterSnapshot(): { global: Logger | null; sessions: ReadonlyMap<string, Logger> } {
  return {
    global: consoleBridgeState.globalLogger,
    sessions: consoleBridgeState.sessionLoggers,
  };
}

// ─── Legacy compat aliases ───────────────────────────────────────────────────
// 历史命名（attachConsoleLogger / detachConsoleLogger / getConsoleLogger）保留，
// 内部委托给新 API。外部 caller（SessionManager 单点）已迁移到 setGlobalLogger，
// 这层 alias 仅给可能的旧测试 / 旧文档代码兜底，不出现在新代码里。

/** @deprecated 用 `setGlobalLogger`；多 sid 场景下"attach"语义已经歧义。 */
export function attachConsoleLogger(logger: Logger, opts?: { agentId?: string; turn?: number }): void {
  setGlobalLogger(logger, opts);
}

/** @deprecated 用 `unsetGlobalLogger`。 */
export function detachConsoleLogger(logger?: Logger): void {
  unsetGlobalLogger(logger);
}

/** @deprecated 用 `getConsoleRouterSnapshot().global`。 */
export function getConsoleLogger(): Logger | null {
  return consoleBridgeState.globalLogger;
}

// ─── feedback emitter ────────────────────────────────────────────────────────
//
// installConsoleBridge 截到 warn/error 时会调一次 emitter（不依赖任何 wrapper）。
// `toAgent` 仅在 `withModelFeedback()` 包内为 true，提示 emitter 把消息额外路
// 由进 agent 自己的 inbox（下一 turn 的 prompt 看得到）；否则只 publish 给
// observers（UI 看到、model 不看到）。

export function attachConsoleEventEmitter(
  emit: (agentId: string, level: "warn" | "error", msg: string, toAgent: boolean) => void,
): void {
  consoleBridgeState.emit = emit;
}

export function detachConsoleEventEmitter(): void {
  consoleBridgeState.emit = undefined;
}

/** Run fn so warn/error ADDITIONALLY route into the agent's own queue —
 *  agent will see them next turn for self-correction. */
export function withModelFeedback<T>(fn: () => T): T {
  const prev = consoleBridgeState.emitToAgent;
  consoleBridgeState.emitToAgent = true;
  try { return fn(); }
  finally { consoleBridgeState.emitToAgent = prev; }
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerConfig {
  /** Append-only, size-rotated. SessionManager: `<userRoot>/debug.log`;
   *  per-Session: `<sessionRoot>/logs/debug.log`. */
  debugLogPath: string;
  /** Truncated per process start. Only set for per-Session logger
   *  (`<sessionRoot>/logs/latest.log`); SessionManager singleton omits this. */
  latestLogPath?: string;
}

export class Logger {
  private readonly debugPath: string;
  private debugStream: WriteStream;
  private debugBytes = 0;
  private readonly latestStream?: WriteStream;
  private closed = false;
  public level: LogLevel = LogLevel.DEBUG;

  constructor(config: LoggerConfig) {
    this.debugPath = config.debugLogPath;
    mkdirSync(dirname(this.debugPath), { recursive: true });
    this.debugStream = createWriteStream(this.debugPath, { flags: "a" });
    try { this.debugBytes = statSync(this.debugPath).size; } catch { this.debugBytes = 0; }

    if (config.latestLogPath) {
      mkdirSync(dirname(config.latestLogPath), { recursive: true });
      this.latestStream = createWriteStream(config.latestLogPath, { flags: "w" });
    }
    // 注意：跟 ref 不同，这里**不**自动 `attachConsoleLogger(this)`。多 Logger
    // 场景下由外层（SessionManager）显式 attach 一次，避免 new Session 抢 slot。
  }

  debug(agentId: string, turn: number | undefined, msg: string, err?: Error): void {
    this.write(LogLevel.DEBUG, agentId, turn, msg, err);
  }
  info(agentId: string, turn: number | undefined, msg: string, err?: Error): void {
    this.write(LogLevel.INFO, agentId, turn, msg, err);
  }
  warn(agentId: string, turn: number | undefined, msg: string, err?: Error): void {
    this.write(LogLevel.WARN, agentId, turn, msg, err);
  }
  error(agentId: string, turn: number | undefined, msg: string, err?: Error): void {
    this.write(LogLevel.ERROR, agentId, turn, msg, err);
  }

  private write(level: LogLevel, agentId: string, turn: number | undefined, msg: string, err?: Error): void {
    if (level < this.level || this.closed) return;

    const line = this.formatLine(level, agentId, turn, msg, err);
    process.stderr.write(line);
    this.debugStream.write(line);
    this.debugBytes += Buffer.byteLength(line);
    if (this.debugBytes >= MAX_FILE_SIZE) this.rotateDebug();

    // INFO+ 同步落 latest.log，让 `tail -f latest` 看到关键信号。
    if (this.latestStream && level >= LogLevel.INFO) {
      this.latestStream.write(line);
    }
  }

  /** prefix 拼接是内部职责 —— 对外 caller 只传 agentId + turn 参数。
   *  格式：`[HH:MM:SS.mmm] [LEVEL] [agentId#turn] msg`（无 turn 时只 agentId）。 */
  private formatLine(level: LogLevel, agentId: string, turn: number | undefined, msg: string, err?: Error): string {
    const tag = turn !== undefined ? `${agentId}#${turn}` : agentId;
    let line = `[${ts()}] [${LEVEL_LABELS[level]}] [${tag}] ${msg}`;
    if (err) line += `\n  ${err.stack ?? err.message}`;
    return line + "\n";
  }

  private rotateDebug(): void {
    this.debugStream.end();
    this.debugStream = rotateLogFile(this.debugPath);
    this.debugBytes = 0;
  }

  async flush(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.debugStream.writableNeedDrain) resolve();
      else this.debugStream.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Defensive: remove self from both router slots. caller (SessionManager /
    // Session) 通常已经显式 unset/unregister 过；这里再扫一遍，避免 close 后
    // bridge 仍然指向已关闭 stream（写入会抛 ERR_STREAM_DESTROYED）。
    if (consoleBridgeState.globalLogger === this) consoleBridgeState.globalLogger = null;
    for (const [sid, logger] of consoleBridgeState.sessionLoggers) {
      if (logger === this) consoleBridgeState.sessionLoggers.delete(sid);
    }
    await this.flush();
    // 两条流都要 await end —— end(cb) 回调在缓冲写尽 + fd 关闭后才触发。此前
    // latestStream.end() 是 fire-and-forget:close() 在 latest.log 的 INFO+ 行还没
    // 落盘时就 resolve,高负载下紧接着读 latest.log 会得到空串(满载偶发的 flake)。
    await Promise.all([
      new Promise<void>((resolve) => this.debugStream.end(() => resolve())),
      this.latestStream
        ? new Promise<void>((resolve) => this.latestStream!.end(() => resolve()))
        : Promise.resolve(),
    ]);
  }
}
