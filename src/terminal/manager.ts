import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFile, appendFile, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  TerminalManagerAPI,
  TerminalInstance,
  ExecOpts,
  ExecResult,
  ExecSyncOpts,
  WaitResult,
} from "../core/types.js";
import { buildAgentShellEnv, buildSandboxExecArgs } from "./env-builder.js";
import { getSandboxManager } from "../sandbox/manager.js";
import { buildContainerDiagnostic, probeRecoveryKind, triggerRecovery } from "../sandbox/container-recovery.js";
import { resolveContainerUser } from "../sandbox/user-resolver.js";
import { getPathManager } from "../fs/path-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_CAPTURE = 512_000;
const MAX_MARKER_BUF = 64_000;
const STATE_DIR = ".shell_state";

let terminalManagerInstance: TerminalManager | null = null;

// ─── Internal types ───

interface PendingCommand {
  marker: string;
  /** Small buffer used only for marker detection — NOT for log accumulation */
  markerBuf: string;
  onComplete: (exitCode: number | undefined, diagnostic?: string) => void;
}

interface ShellSession {
  id: string;
  /** Key in sharedShells pool; may include ":host" suffix for forceHost sessions. */
  poolKey: string;
  /** Base agent id for env/path resolution; never includes pool suffixes. */
  baseAgentId: string;
  /** Resolved execution environment: "host" or "container". */
  environmentKey: "host" | "container";
  process: ChildProcess;
  shellPath: string;
  pending: PendingCommand | null;
  /** Tail promise of the per-session command queue. */
  queueTail: Promise<void>;
  terminalIds: Set<string>;
  spawnError?: Error;
  stderrTail: string;
}

// ─── Singleton helpers ───

export function initTerminalManager(): TerminalManager {
  if (!terminalManagerInstance) {
    terminalManagerInstance = new TerminalManager();
  }
  return terminalManagerInstance;
}

export function getTerminalManager(): TerminalManager {
  if (!terminalManagerInstance) {
    throw new Error("TerminalManager not initialized");
  }
  return terminalManagerInstance;
}

// ─── TerminalManager ───

export class TerminalManager implements TerminalManagerAPI {
  private terminals    = new Map<string, TerminalInstance>();
  private sharedShells = new Map<string, ShellSession>();
  private sessions     = new Map<string, ShellSession>();
  private terminalCounter = 0;
  private sessionCounter  = 0;

  /** Callbacks awaiting a specific terminal to finish. Fired in `notifyCompletionWaiters`. */
  private completionWaiters = new Map<string, Array<() => void>>();

  /** 幂等 init Promise — 第一次 init() 后复用 */
  private initPromise: Promise<void> | null = null;
  private _ready = false;
  /** FSWatcher 注册凭证，cleanup(0) 时释放，防止重复注册 */
  private watcherDisposables: Array<{ dispose(): void }> = [];

  constructor() {}

  // ─── Lifecycle (init / isReady / ensureReady) ───

  isReady(): boolean { return this._ready; }

  async ensureReady(): Promise<void> {
    if (this._ready) return;
    // 无论 init() 是否已被调用，都通过 init() 确保初始化触发且等待完成
    await this.init();
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().then(() => { this._ready = true; });
    return this.initPromise;
  }

  /** Reserved for future use (e.g. .env file watcher registration). */
  private async _doInit(): Promise<void> {
    // Currently no-op. env changes are applied via `source .env` in the shell.
  }

  // ─── Path helpers ───

  /**
   * Terminal log 目录：
   *   有 agentId → team/terminals/{baseAgentId}/
   *   无 agentId → team/terminals/
   *
   * 路径归属仍是 TeamLayer，不经过 AgentLayer。
   */
  private logDirFor(agentId: string | undefined): string {
    const base = getPathManager().team().terminalsDir();
    const id = this.baseAgentId(agentId);
    return id ? join(base, id) : base;
  }

  private baseAgentId(agentId: string | undefined): string {
    if (!agentId) return "";
    return agentId.split(":")[0];
  }

  /** cwd 状态文件：{logDir}/.shell_state/cwd */
  private stateDirFor(agentId: string | undefined): string {
    return join(this.logDirFor(agentId), STATE_DIR);
  }

  private cwdFile(agentId: string | undefined): string {
    return join(this.stateDirFor(agentId), "cwd");
  }

  // ─── Agent env ───

  /**
   * Docker 模式：确保容器已启动（供 createInstance 初始化调用）。
   * Direct 模式：no-op，env 在每次 createSession 时现读，无需预构建。
   */
  async loadSystemEnv(): Promise<void> {
    // Direct 模式下无需任何操作
  }

  /**
   * 确保 agent 对应的运行环境就绪。
   * - Docker 模式：触发 ensureSandbox()，确保容器已启动。
   * - Direct 模式：no-op，env 在每次 createSession 时现读 .env 文件。
   *
   * 调用方：Scheduler.initAgent()
   */
  async loadAgentEnv(agentId: string): Promise<void> {
    if (!agentId) return;
    const sandbox = getSandboxManager();
    if (sandbox?.isEnabled()) {
      await sandbox.ensureSandbox();
    }
  }

  // ─── Shell session management ───

  private resolveShellPath(agentEnv: Record<string, string>): string {
    const candidates = [
      agentEnv.SHELL || process.env.SHELL,
      "/usr/bin/bash",
      "/bin/bash",
      "bash",
    ].filter((v): v is string => Boolean(v));
    for (const c of candidates) {
      if (!c.includes("/")) return c;
      if (existsSync(c)) return c;
    }
    return "bash";
  }

  private resolveSessionCwd(initialCwd?: string, agentId?: string): string {
    const pm = getPathManager();
    if (!initialCwd) {
      return agentId ? pm.team().homeFor(agentId) : pm.root();
    }
    try {
      if (statSync(initialCwd).isDirectory()) return initialCwd;
    } catch { /* stale path */ }
    return agentId ? pm.team().homeFor(agentId) : pm.root();
  }

  private async buildSessionFailureDiagnostic(
    session: ShellSession,
    reason: "spawn_error" | "shell_exit",
    exitCode?: number,
  ): Promise<string> {
    const isDocker = session.environmentKey === "container";
    const lines = [
      "",
      `[shell session failed: ${reason}]`,
    ];

    if (typeof exitCode === "number") {
      lines.push(`session_exit_code: ${exitCode}`);
    }
    if (session.spawnError?.message) {
      lines.push(`spawn_error: ${session.spawnError.message}`);
    }

    const stderr = session.stderrTail.trim();
    if (stderr) {
      lines.push("", "[shell stderr]", stderr);
    }

    if (isDocker) {
      const kind = await probeRecoveryKind();
      lines.push(buildContainerDiagnostic("shell", session.spawnError ?? new Error(reason), kind));
    }

    return lines.join("\n") + "\n";
  }

  private spawnShellProcess(
    shellPath: string,
    builtEnv: NodeJS.ProcessEnv,
    sessionCwd: string,
    baseAgentId: string,
    environmentKey: "host" | "container",
  ): ChildProcess {
    const sandbox = getSandboxManager();
    if (environmentKey === "container" && sandbox?.isEnabled() && baseAgentId) {
      return sandbox.spawnInContainer({
        command: "bash",
        args: ["--norc", "--noprofile"],
        cwd: sessionCwd,
        user: resolveContainerUser(false),
        envArgs: buildSandboxExecArgs(baseAgentId, getPathManager()),
      });
    }
    return spawn(shellPath, ["--norc", "--noprofile"], {
      cwd: sessionCwd,
      env: { ...builtEnv, PS1: "", PS2: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }


  private attachSessionObservers(cacheKey: string, session: ShellSession): void {
    const child = session.process;

    // Completion markers are emitted on stdout; stderr is buffered for diagnostics when
    // the shell exits before the wrapped command can finish.
    child.stdout?.on("data", (data: Buffer) => {
      if (!session.pending) return;
      session.pending.markerBuf += data.toString("utf-8");

      // Guard against unbounded growth if command output leaks to stdout
      // (e.g. when bash -c wrapper fails to capture). Keep the tail so
      // the marker at the end is still detectable.
      if (session.pending.markerBuf.length > MAX_MARKER_BUF) {
        session.pending.markerBuf = session.pending.markerBuf.slice(-MAX_MARKER_BUF / 2);
      }

      const idx = session.pending.markerBuf.indexOf(session.pending.marker);
      if (idx === -1) return;

      const after = session.pending.markerBuf.slice(idx + session.pending.marker.length).trim();
      const exitCode = parseInt(after, 10);

      const cb = session.pending.onComplete;
      session.pending = null;
      cb(isNaN(exitCode) ? undefined : exitCode);
    });

    child.stderr?.on("data", (data: Buffer) => {
      session.stderrTail = trimTail(session.stderrTail + data.toString("utf-8"));
    });

    child.on("error", (err) => {
      session.spawnError = err instanceof Error ? err : new Error(String(err));
      if (session.pending) {
        const cb = session.pending.onComplete;
        session.pending = null;
        this.buildSessionFailureDiagnostic(session, "spawn_error").then(
          (diag) => cb(undefined, diag),
        );
      }
      this.cleanupSession(cacheKey, session);
      if (session.environmentKey === "container") triggerRecovery("spawn_error");
    });

    child.on("exit", (code) => {
      if (session.pending) {
        const cb = session.pending.onComplete;
        session.pending = null;
        this.buildSessionFailureDiagnostic(session, "shell_exit", code ?? 1).then(
          (diag) => cb(code ?? 1, diag),
        );
      }
      this.cleanupSession(cacheKey, session);
      if (session.environmentKey === "container" && session.baseAgentId) {
        triggerRecovery("shell_exit");
      }
    });
  }

  private writeSessionInitScripts(session: ShellSession, initScript?: string): void {
    // Restore prior cwd when creating a replacement session
    if (initScript) {
      try { session.process.stdin?.write(initScript + "\n"); } catch { /* ignore */ }
    }
  }

  private async createSession(baseAgentId: string, poolKey: string, environmentKey: "host" | "container", initialCwd?: string, initScript?: string): Promise<ShellSession> {
    // 每次创建 session 时现读 .env 文件（Direct: 传给 spawn env；Docker: spawnShellProcess 内部用 --env-file，builtEnv 被忽略）
    const builtEnv = await buildAgentShellEnv(baseAgentId || undefined, getPathManager());
    const shellPath = this.resolveShellPath(builtEnv as Record<string, string>);
    const sessionCwd = this.resolveSessionCwd(initialCwd, baseAgentId || undefined);
    const child = this.spawnShellProcess(shellPath, builtEnv, sessionCwd, baseAgentId, environmentKey);

    const session: ShellSession = {
      id: `s${++this.sessionCounter}-${Date.now()}`,
      poolKey,
      baseAgentId,
      environmentKey,
      process: child,
      shellPath,
      pending: null,
      queueTail: Promise.resolve(),
      terminalIds: new Set(),
      stderrTail: "",
    };

    this.attachSessionObservers(poolKey, session);
    this.writeSessionInitScripts(session, initScript);

    this.sessions.set(session.id, session);
    return session;
  }

  private cleanupSession(poolKey: string, session: ShellSession): void {
    if (this.sharedShells.get(poolKey) === session) {
      this.sharedShells.delete(poolKey);
    }
    this.sessions.delete(session.id);
  }

  /** Return the shared bash for this agent, creating one if needed.
   *  On timeout the session is detached (removed from the pool) but kept alive so it can finish
   *  writing the log and cwd state. A fresh session is created for subsequent commands. */
  private async getOrCreateSharedShell(agentId: string | undefined, initialCwd?: string, environmentKey?: "host" | "container"): Promise<ShellSession> {
    const baseAgentId = agentId ? this.baseAgentId(agentId) : "";
    const resolved = environmentKey ?? ((getSandboxManager()?.isEnabled() ?? false) ? "container" : "host");
    const poolKey = `${baseAgentId}:${resolved}`;
    const existing = this.sharedShells.get(poolKey);
    if (existing && existing.process.exitCode === null) {
      return existing;
    }

    // Build an init script that restores the previous working directory if available
    let initScript: string | undefined;
    try {
      const savedCwd = (await readFile(this.cwdFile(agentId), "utf-8")).trim();
      if (savedCwd) {
        initScript = `cd ${shellQuote(savedCwd)} 2>/dev/null || true`;
      }
    } catch { /* no state to restore */ }

    const session = await this.createSession(baseAgentId, poolKey, resolved, initialCwd, initScript);
    this.sharedShells.set(poolKey, session);
    return session;
  }

  private enqueueSessionTurn(session: ShellSession): {
    waitTurn: Promise<void>;
    releaseTurn: () => void;
  } {
    const waitTurn = session.queueTail.catch(() => undefined);
    let resolveTurn!: () => void;
    let released = false;
    const myTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    session.queueTail = waitTurn.then(() => myTurn);

    return {
      waitTurn,
      releaseTurn: () => {
        if (released) return;
        released = true;
        resolveTurn();
      },
    };
  }

  private async acquireQueuedSession(agentId: string | undefined, initialCwd?: string, environmentKey?: "host" | "container"): Promise<{
    session: ShellSession;
    releaseTurn: () => void;
  }> {
    while (true) {
      const session = await this.getOrCreateSharedShell(agentId, initialCwd, environmentKey);
      const { waitTurn, releaseTurn } = this.enqueueSessionTurn(session);
      await waitTurn;

      // A previous command may have timed out and detached this shell from the pool.
      // In that case, retry against the fresh replacement session instead of writing
      // into the detached shell concurrently with the backgrounded job.
      if (this.sharedShells.get(session.poolKey) !== session || session.process.exitCode !== null) {
        releaseTurn();
        continue;
      }

      return { session, releaseTurn };
    }
  }

  // ─── exec ───

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const logDir  = this.logDirFor(opts.agentId);
    const stDir   = this.stateDirFor(opts.agentId);
    await mkdir(logDir, { recursive: true });
    await mkdir(stDir,  { recursive: true });

    const id      = `t${++this.terminalCounter}-${Date.now()}`;
    const descSlug = opts.description ? `-${slugify(opts.description)}` : "";
    const logFile = join(logDir, `${id}${descSlug}.txt`);
    const marker  = `__MCEND_${id}__`;
    const startedAt = Date.now();

    const cwdF = this.cwdFile(opts.agentId);

    // If already aborted before we even start, bail out immediately.
    if (opts.signal?.aborted) {
      return { terminalId: id, logFile, stdout: "[aborted]", backgrounded: false };
    }

    // Phase 1: wait for the shared session to become available.
    // If signal fires here, abandon the queue slot and resolve immediately.
    let acquired: { session: ShellSession; releaseTurn: () => void } | null = null;
    if (opts.signal) {
      const acquirePromise = this.acquireQueuedSession(opts.agentId, opts.initialCwd, opts.environmentKey);
      const abortPromise   = new Promise<null>((resolve) => {
        opts.signal!.addEventListener("abort", () => resolve(null), { once: true });
      });
      const result = await Promise.race([acquirePromise, abortPromise]);
      if (result === null) {
        return { terminalId: id, logFile, stdout: "[aborted before execution]", backgrounded: false };
      }
      acquired = result;
    } else {
      acquired = await this.acquireQueuedSession(opts.agentId, opts.initialCwd, opts.environmentKey);
    }

    const { session, releaseTurn } = acquired;

    const instance: TerminalInstance = {
      id,
      sessionId: session.id,
      pid: session.process.pid ?? -1,
      command,
      cwd: opts.cwd ?? ".",
      agentId: opts.agentId,
      startedAt,
      logFile,
    };
    this.terminals.set(id, instance);
    session.terminalIds.add(id);

    if (session.spawnError || !session.process.stdin) {
      releaseTurn();
      const msg = `Shell unavailable (${session.shellPath}): ${session.spawnError?.message ?? "spawn failure"}`;
      instance.exitCode = 127;
      instance.elapsedMs = 0;
      await this.writeLog(instance, msg, true);
      return { terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false };
    }

    // Write log header immediately so the file exists and is readable before the command finishes
    await this.writeLog(instance, "", false);

    const wrapped = buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt });

    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const effectiveTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;

      /**
       * Shared tail for abort and timeout paths: detach the session from the shared pool
       * (so subsequent execs get a fresh session while this one finishes in the background),
       * release the turn lock, and resolve with `backgrounded: true`.
       *
       * `stdout` is returned to the caller as-is; `note` (wrapped with newlines) is appended
       * to the log file so that later `wait()` / `read_file` readers see the background marker.
       */
      const backgroundAndSettle = (stdout: string, hint: string) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        instance.backgrounded = true;
        appendFile(logFile, `\n${stdout}\n`, "utf-8").catch(() => {});
        if (this.sharedShells.get(session.poolKey) === session) {
          this.sharedShells.delete(session.poolKey);
        }
        releaseTurn();
        resolve({ terminalId: id, logFile, stdout, backgrounded: true, hint });
      };

      // Phase 2: abort handler — SIGINT the foreground job and background the session.
      // This mirrors the timeout-background path so the session stays alive and cwd is preserved.
      if (opts.signal) {
        const onAbort = () => {
          if (settled) return;
          // Send SIGINT to the process group to interrupt the foreground job.
          // NOTE: In Docker mode, -pid targets the `docker exec` process, not the
          // container-internal command. The \x03 fallback is more reliable there.
          try { process.kill(-session.process.pid!, "SIGINT"); } catch {
            try { session.process.stdin?.write("\x03"); } catch { /* ignore */ }
          }
          backgroundAndSettle(
            "[aborted by steer]",
            `Command was interrupted. Partial output: ${logFile}`,
          );
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // If timeout <= 0, we don't set a timer. It will wait indefinitely.
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          backgroundAndSettle(
            `[still running — backgrounded after ${effectiveTimeout}ms]`,
            `Command running in background. Poll log: ${logFile}`,
          );
        }, effectiveTimeout);
      }

      session.pending = {
        marker,
        markerBuf: "",
        // NOTE: onComplete may fire after timeout/abort has already settled the promise.
        // In that case, `settled === true` guards against double-resolve. releaseTurn()
        // is also idempotent. This is intentional — the detached session finishes its
        // command in the background and cleans up here.
        onComplete: async (exitCode, diagnostic) => {
          if (timer) clearTimeout(timer);
          session.terminalIds.delete(id);
          instance.exitCode  = exitCode;
          instance.elapsedMs = Date.now() - startedAt;
          releaseTurn();

          // Wake anyone blocked in wait() on this terminal. Fires BEFORE the `!settled`
          // resolve so that concurrent wait()/exec() callers both see completion.
          this.notifyCompletionWaiters(id);

          if (diagnostic) {
            const footer = [
              "",
              "---",
              `exit_code: ${instance.exitCode ?? "unknown"}`,
              `elapsed_ms: ${instance.elapsedMs}`,
              "---",
              "",
            ].join("\n");
            await appendFile(logFile, diagnostic + footer, "utf-8").catch(() => {});
          }

          if (!settled) {
            settled = true;
            const body = await readLogBody(logFile);
            let postCwd: string | undefined;
            try { postCwd = (await readFile(cwdF, "utf-8")).trim() || undefined; } catch { /* no cwd state */ }
            resolve({ terminalId: id, logFile, stdout: body, exitCode, backgrounded: false, cwd: postCwd });
          }
        },
      };

      try {
        session.process.stdin!.write(wrapped);
      } catch (err) {
        if (timer) clearTimeout(timer);
        session.terminalIds.delete(id);
        session.pending = null;
        releaseTurn();
        const msg = `Shell write failed: ${err instanceof Error ? err.message : String(err)}`;
        instance.exitCode = 127;
        instance.elapsedMs = Date.now() - startedAt;
        void this.writeLog(instance, msg, true);
        this.notifyCompletionWaiters(id);
        if (!settled) {
          settled = true;
          resolve({ terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false });
        }
      }
    });
  }

  // ─── Completion-waiter plumbing ───

  private notifyCompletionWaiters(terminalId: string): void {
    const waiters = this.completionWaiters.get(terminalId);
    if (!waiters) return;
    this.completionWaiters.delete(terminalId);
    for (const w of waiters) { try { w(); } catch { /* ignore waiter errors */ } }
  }

  private addCompletionWaiter(terminalId: string, cb: () => void): () => void {
    let arr = this.completionWaiters.get(terminalId);
    if (!arr) { arr = []; this.completionWaiters.set(terminalId, arr); }
    arr.push(cb);
    return () => {
      const cur = this.completionWaiters.get(terminalId);
      if (!cur) return;
      const idx = cur.indexOf(cb);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.completionWaiters.delete(terminalId);
    };
  }

  // ─── TerminalManagerAPI implementation ───

  get(id: string): TerminalInstance | undefined {
    return this.terminals.get(id);
  }

  list(filter?: { agentId?: string; status?: string }): TerminalInstance[] {
    const result: TerminalInstance[] = [];
    for (const [, t] of this.terminals) {
      if (filter?.agentId && t.agentId !== filter.agentId) continue;
      if (filter?.status === "running" && t.exitCode !== undefined) continue;
      if (filter?.status === "done"    && t.exitCode === undefined) continue;
      result.push(t);
    }
    return result;
  }

  kill(id: string): boolean {
    const session = [...this.sessions.values()].find((s) => s.terminalIds.has(id));
    if (!session || session.process.exitCode !== null) return false;
    // Send SIGINT to the process group to interrupt the foreground job in the shared shell.
    // In Docker mode, -pid targets `docker exec` — the \x03 fallback is more reliable.
    try {
      process.kill(-session.process.pid!, "SIGINT");
      return true;
    } catch {
      try { session.process.stdin!.write("\x03"); return true; } catch { return false; }
    }
  }

  async wait(terminalId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const instance = this.terminals.get(terminalId);
    if (!instance) {
      return { terminalId, status: "not_found", stdout: "", logFile: "" };
    }

    // Already finished → snapshot and return immediately.
    if (instance.exitCode !== undefined) {
      return {
        terminalId,
        status: "done",
        exitCode: instance.exitCode,
        elapsedMs: instance.elapsedMs,
        stdout: await readLogBody(instance.logFile),
        logFile: instance.logFile,
      };
    }

    // Caller wants a pure snapshot or signal is already aborted → no waiting.
    if (timeoutMs <= 0 || signal?.aborted) {
      return {
        terminalId,
        status: "still_running",
        stdout: await readLogBody(instance.logFile),
        logFile: instance.logFile,
      };
    }

    // Arm the waiter — race against timeout and optional abort.
    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let removeWaiter: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      // Single cleanup point for all three outcomes (done / timeout / abort):
      // whichever path settles first calls cleanup() to release the remaining handlers.
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (removeWaiter) { removeWaiter(); removeWaiter = null; }
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
      };

      const finishDone = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          terminalId,
          status: "done",
          exitCode: instance.exitCode,
          elapsedMs: instance.elapsedMs,
          stdout: await readLogBody(instance.logFile),
          logFile: instance.logFile,
        });
      };

      const finishStillRunning = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          terminalId,
          status: "still_running",
          stdout: await readLogBody(instance.logFile),
          logFile: instance.logFile,
        });
      };

      timer = setTimeout(() => { void finishStillRunning(); }, timeoutMs);
      removeWaiter = this.addCompletionWaiter(terminalId, () => { void finishDone(); });

      if (signal) {
        abortHandler = () => { void finishStillRunning(); };
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  cleanup(maxAge?: number): void {
    if (maxAge === 0) {
      for (const [, session] of this.sessions) {
        try { session.process.kill("SIGTERM"); } catch {}
      }
      this.sharedShells.clear();
      this.sessions.clear();
      // 抛弃 wait() 挂起者；它们各自的 setTimeout 仍会触发 "still_running" 快照回报，
      // 不会永挂（终端没真完成，故不走 "done" 路径）。
      this.completionWaiters.clear();
      // 重置初始化状态，使 ensureReady() → init() 可重新执行（例如 loadPackToTeam 后）
      this._ready = false;
      this.initPromise = null;
      // 释放旧的 FSWatcher 注册，防止 _doInit() 重入时重复注册
      for (const d of this.watcherDisposables) d.dispose();
      this.watcherDisposables = [];
    }
    const cutoff = Date.now() - (maxAge ?? 3_600_000);
    for (const [id, t] of this.terminals) {
      if (t.exitCode !== undefined && t.startedAt < cutoff) {
        this.terminals.delete(id);
        unlink(t.logFile).catch(() => {});
      }
    }
  }

  // ─── Log helpers ───

  private async writeLog(instance: TerminalInstance, body: string, finished = false): Promise<void> {
    const header = [
      "---",
      `id: ${instance.id}`,
      `session_id: ${instance.sessionId}`,
      `pid: ${instance.pid}`,
      `cwd: ${instance.cwd}`,
      `command: ${instance.command}`,
      `agent: ${instance.agentId ?? "system"}`,
      `started_at: ${new Date(instance.startedAt).toISOString()}`,
      "---",
      "",
    ].join("\n");

    if (finished) {
      const footer = [
        "",
        "---",
        `exit_code: ${instance.exitCode ?? "unknown"}`,
        `elapsed_ms: ${instance.elapsedMs ?? Date.now() - instance.startedAt}`,
        "---",
      ].join("\n");
      await writeFile(instance.logFile, header + body + footer).catch(() => {});
    } else {
      // Write only header; bash will append the body + footer directly
      await writeFile(instance.logFile, header).catch(() => {});
    }
  }

  // ─── execSync — lightweight one-shot command, auto-routed ──────────────

  execSync(command: string, args: string[], opts?: ExecSyncOpts): string {
    const cwd = opts?.cwd;
    const timeout = opts?.timeout ?? 30_000;
    const input = opts?.input;
    const extraEnv = opts?.env;

    const sandbox = getSandboxManager();
    if (sandbox?.isEnabled()) {
      const containerName = sandbox.getContainerName();
      const dockerArgs = ["exec", "-i", "--user", resolveContainerUser(opts?.privileged ?? false)];
      if (cwd) dockerArgs.push("--workdir", cwd);
      if (extraEnv) {
        for (const [k, v] of Object.entries(extraEnv)) {
          dockerArgs.push("--env", `${k}=${v}`);
        }
      }
      dockerArgs.push(containerName, command, ...args);

      const result = spawnSync("docker", dockerArgs, {
        encoding: "utf-8",
        timeout,
        input,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const err = new Error(result.stderr?.trim() || `${command} ${args[0] ?? ""} failed (code ${result.status})`);
        (err as any).stderr = result.stderr;
        throw err;
      }
      return (result.stdout ?? "").trim();
    }

    const mergedEnv = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    const result = spawnSync(command, args, {
      cwd,
      env: mergedEnv,
      encoding: "utf-8",
      timeout,
      input,
    });
    if (result.status !== 0) {
      const err = new Error(result.stderr?.trim() || `${command} ${args[0] ?? ""} failed (code ${result.status})`);
      (err as any).stderr = result.stderr;
      throw err;
    }
    return (result.stdout ?? "").trim();
  }
}

// ─── Helpers ───

interface WrapOpts {
  command: string;
  opts: ExecOpts;
  logFile: string;
  cwdF: string;
  marker: string;
  startedAt: number;
}

/** Wrap a user command so that:
 *  - stdout + stderr stream directly into the log file (real-time, no Node buffering)
 *  - cwd is persisted after completion for new-session restore
 *  - cd side-effects persist in the long-lived shell (CURRENT_DIR stays in sync)
 *  - a unique marker is echoed to bash stdout so Node knows when the command finished
 *
 *  Uses `eval` with single-quote wrapping (à la the reference agent CLI) instead of `bash -c`.
 *  `bash -c` forks a child process, so `cd` effects are lost when it exits.
 *  `eval` runs in the current shell, preserving cwd changes.
 *
 *  The `{ eval ...; __mc_rc=$?; } ... || __mc_rc=$?` brace-group pattern ensures:
 *    1. `set -e` inside the command cannot cascade into the outer session
 *    2. exit code is always captured regardless of errexit state
 *    3. heredoc parsing is contained within the eval's second parse pass */
function buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt }: WrapOpts): string {
  let cmd = command;
  if (opts.cwd) cmd = `cd ${shellQuote(opts.cwd)} && { ${cmd} ; }`;

  const quoted = evalQuote(cmd);
  return [
    `{ eval ${quoted}; __mc_rc=$?; } < /dev/null >> ${shellQuote(logFile)} 2>&1 || __mc_rc=$?`,
    `pwd > ${shellQuote(cwdF)} 2>/dev/null || true`,
    `printf '\\n---\\nexit_code: '%s'\\nelapsed_ms: '%s'\\n---\\n'` +
      ` "$__mc_rc" "$(($(date +%s%3N) - ${startedAt}))" >> ${shellQuote(logFile)} 2>/dev/null || true`,
    `echo ""`,
    `echo "${marker} $__mc_rc"`,
  ].join("\n") + "\n";
}

/** Single-quote a string for use as a `bash -c` or path argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Single-quote a command string for `eval '...'`.
 *  Preserves newlines (eval handles them correctly during second parse). */
function evalQuote(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

/** Convert a description string to a safe filename slug (max 32 chars). */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}

function trimTail(s: string, maxLen = 16_000): string {
  return s.length <= maxLen ? s : s.slice(-maxLen);
}

/** Read the log body (everything after the header) for inline return to the caller. */
async function readLogBody(logFile: string): Promise<string> {
  try {
    const raw = await readFile(logFile, "utf-8");
    // Skip the 9-line header block (--- ... ---\n\n)
    const headerEnd = raw.indexOf("\n---\n", raw.indexOf("---\n") + 4);
    const body = headerEnd !== -1 ? raw.slice(headerEnd + 5) : raw;
    return body.slice(0, MAX_STDOUT_CAPTURE);
  } catch {
    return "";
  }
}
