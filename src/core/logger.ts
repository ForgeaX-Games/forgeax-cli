import { createWriteStream, statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, dirname } from "node:path";
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

type ConsoleMethod = "debug" | "log" | "info" | "warn" | "error";
type ConsoleFn = (...args: unknown[]) => void;
export interface LogContext {
  agentId: string;
  turn?: number;
}

const CONSOLE_METHODS: ConsoleMethod[] = ["debug", "log", "info", "warn", "error"];
const DEFAULT_LOG_CONTEXT: LogContext = { agentId: "system" };
const logContextStorage = new AsyncLocalStorage<LogContext>();

const consoleBridgeState: {
  installed: boolean;
  logger: Logger | null;
  defaultContext: LogContext;
  originals: Partial<Record<ConsoleMethod, ConsoleFn>>;
  emit?: (agentId: string, level: "warn" | "error", msg: string, toAgent: boolean) => void;
  emitToAgent: boolean;
} = {
  installed: false,
  logger: null,
  defaultContext: DEFAULT_LOG_CONTEXT,
  originals: {},
  emitToAgent: false,
};

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
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

function forwardToOriginalConsole(method: ConsoleMethod, args: unknown[]): void {
  const msg = formatConsoleArgs(args);
  const line = `[${ts()}] [${L0_LEVEL[method]}] [gateway] ${msg}\n`;
  process.stderr.write(line);
}

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? consoleBridgeState.defaultContext;
}

/** Enter an agent scope WITH a specific turn number (inside a turn). */
export function runWithAgentTurn<T>(agentId: string, turn: number, fn: () => T): T {
  return logContextStorage.run({ agentId, turn }, fn);
}

/** Enter an agent scope WITHOUT a turn (loading, plugin callbacks, background work). */
export function runWithAgentScope<T>(agentId: string, fn: () => T): T {
  return logContextStorage.run({ agentId }, fn);
}

/** Bind an agent scope to a callback — the returned function carries the LogContext automatically.
 *  Useful for setTimeout / observe / watch callbacks that escape AsyncLocalStorage. */
export function bindAgentScope<TArgs extends unknown[], TResult>(
  agentId: string,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => runWithAgentScope(agentId, () => fn(...args));
}

export function installConsoleBridge(): void {
  if (consoleBridgeState.installed) return;

  for (const method of CONSOLE_METHODS) {
    consoleBridgeState.originals[method] = console[method].bind(console) as ConsoleFn;
    console[method] = ((...args: unknown[]) => {
      const logger = consoleBridgeState.logger;
      if (!logger) {
        forwardToOriginalConsole(method, args);
        return;
      }

      const msg = formatConsoleArgs(args);
      const { agentId, turn } = getLogContext();

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

export function attachConsoleLogger(logger: Logger, opts?: { agentId?: string; turn?: number }): void {
  installConsoleBridge();
  consoleBridgeState.logger = logger;
  consoleBridgeState.defaultContext = {
    agentId: opts?.agentId ?? DEFAULT_LOG_CONTEXT.agentId,
    ...(opts?.turn !== undefined ? { turn: opts.turn } : {}),
  };
}

export function detachConsoleLogger(logger?: Logger): void {
  if (!logger || consoleBridgeState.logger === logger) {
    consoleBridgeState.logger = null;
  }
}

export function getConsoleLogger(): Logger | null {
  return consoleBridgeState.logger;
}

/**
 * Attach an emitter for warn/error console output. Called for EVERY warn/error
 * (not gated on any wrapper). The `toAgent` flag is true when called inside
 * withModelFeedback() — emitter should then additionally route into the agent's
 * own queue so the model sees it next turn. Otherwise (default), emitter should
 * publish to observers only — UI/wechat-monitor sees, model does NOT.
 */
export function attachConsoleEventEmitter(
  emit: (agentId: string, level: "warn" | "error", msg: string, toAgent: boolean) => void,
): void {
  consoleBridgeState.emit = emit;
}

export function detachConsoleEventEmitter(): void {
  consoleBridgeState.emit = undefined;
}

/**
 * Run fn so that warn/error events ADDITIONALLY route into the agent's own
 * queue — agent will see them in its next turn's prompt for self-correction.
 *
 * Without this wrapper, warn/error are still published to observers (UI sees),
 * but NOT injected into the agent's own context. Use this when the error is
 * actionable by the model: tool execution failure, LLM call failure,
 * slot/configuration errors, declared-name mismatches, etc.
 */
export function withModelFeedback<T>(fn: () => T): T {
  const prev = consoleBridgeState.emitToAgent;
  consoleBridgeState.emitToAgent = true;
  try { return fn(); }
  finally { consoleBridgeState.emitToAgent = prev; }
}

/** Per-agent file logger with latest.log (INFO+) + debug.log (all levels) */
class AgentFileLogger {
  private debugStream: WriteStream;
  private latestStream: WriteStream;
  private debugBytes = 0;
  private debugPath: string;

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.debugPath = join(logDir, "debug.log");
    this.debugStream = createWriteStream(this.debugPath, { flags: "a" });
    this.latestStream = createWriteStream(join(logDir, "latest.log"), { flags: "w" });
    try { this.debugBytes = statSync(this.debugPath).size; } catch { this.debugBytes = 0; }
  }

  write(line: string, isImportant: boolean): void {
    this.debugStream.write(line);
    this.debugBytes += Buffer.byteLength(line);
    if (this.debugBytes >= MAX_FILE_SIZE) this.rotateDebug();
    if (isImportant) this.latestStream.write(line);
  }

  private rotateDebug(): void {
    this.debugStream.end();
    this.debugStream = rotateLogFile(this.debugPath);
    this.debugBytes = 0;
  }

  close(): void {
    this.debugStream.end();
    this.latestStream.end();
  }
}

export interface LoggerConfig {
  /** {instanceRoot}/debug.log — 全量日志路径 */
  debugLogPath: string;
  /** {instanceRoot}/team/logs/ — per-agent 日志目录 */
  agentLogsDir: string;
}

export class Logger {
  private agentLoggers = new Map<string, AgentFileLogger>();
  private agentLogsDir: string;
  private globalDebugStream: WriteStream;
  private globalDebugPath: string;
  private globalDebugBytes = 0;
  private closed = false;
  public level: LogLevel = LogLevel.DEBUG;

  constructor(config: LoggerConfig) {
    this.agentLogsDir = config.agentLogsDir;
    mkdirSync(this.agentLogsDir, { recursive: true });
    this.globalDebugPath = config.debugLogPath;
    mkdirSync(dirname(this.globalDebugPath), { recursive: true });
    this.globalDebugStream = createWriteStream(this.globalDebugPath, { flags: "a" });
    try { this.globalDebugBytes = statSync(this.globalDebugPath).size; } catch { this.globalDebugBytes = 0; }

    attachConsoleLogger(this);
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
    if (level < this.level) return;

    const line = this.formatLine(level, agentId, turn, msg, err);
    this.writeLine(line, level, agentId);
  }

  private formatLine(level: LogLevel, agentId: string, turn: number | undefined, msg: string, err?: Error): string {
    const tag = turn !== undefined ? `${agentId}#${turn}` : agentId;
    let line = `[${ts()}] [${LEVEL_LABELS[level]}] [${tag}] ${msg}`;
    if (err) line += `\n  ${err.stack ?? err.message}`;
    return line + "\n";
  }

  private writeLine(line: string, level: LogLevel, agentId: string): void {
    process.stderr.write(line);
    this.writeGlobal(line);

    const baseAgentId = agentId.split(":")[0];
    if (baseAgentId && baseAgentId !== "system") {
      const logger = this.getOrCreateAgentLogger(baseAgentId);
      logger.write(line, level >= LogLevel.INFO);
    }
  }

  private writeGlobal(line: string): void {
    this.globalDebugStream.write(line);
    this.globalDebugBytes += Buffer.byteLength(line);
    if (this.globalDebugBytes >= MAX_FILE_SIZE) this.rotateGlobal();
  }

  private getOrCreateAgentLogger(agentId: string): AgentFileLogger {
    let bl = this.agentLoggers.get(agentId);
    if (!bl) {
      bl = new AgentFileLogger(join(this.agentLogsDir, agentId));
      this.agentLoggers.set(agentId, bl);
    }
    return bl;
  }

  private rotateGlobal(): void {
    this.globalDebugStream.end();
    this.globalDebugStream = rotateLogFile(this.globalDebugPath);
    this.globalDebugBytes = 0;
  }

  async flush(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.globalDebugStream.writableNeedDrain) {
        resolve();
      } else {
        this.globalDebugStream.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    detachConsoleLogger(this);
    await this.flush();
    for (const bl of this.agentLoggers.values()) bl.close();
    this.agentLoggers.clear();
    return new Promise((resolve) => this.globalDebugStream.end(resolve));
  }
}
