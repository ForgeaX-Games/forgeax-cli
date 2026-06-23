/** TerminalManager —— 持久 bash session 池 + 后台 / wait / log file 抽象。
 *
 *  当前实现 = 宿主机直跑：每个 agentId 共享一根长进程(解析到的 shell + 对应
 *  的 no-rc flags，见 noRcFlags：bash/sh→`--norc --noprofile`、zsh→`-f`)，
 *  命令通过 marker 序列化，stdout/stderr 重定向到日志文件。
 *
 *  TODO（sandbox 阶段）：
 *  - forgeax 的 sandbox 会按 SessionConfig.defaultDir 指向的 game-project
 *    建独立容器，shell session 改为 `docker exec -i container bash`；
 *    state（cwd / env）通过 bind-mount 共享，跟宿主机版本行为对齐。
 *  - `environmentKey` 字段（"host" | "container"）届时补回，sandbox manager
 *    决定路由。当前一律走 host。
 *
 *  ref: `agenteam-os-ref/src/terminal/manager.ts`（去掉所有 sandbox 分支）。 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPathManager } from "../fs/path-manager";
import type {
  TerminalManagerAPI,
  TerminalInstance,
  ExecOpts,
  ExecResult,
  ExecSyncOpts,
  WaitResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_CAPTURE = 512_000;
const MAX_MARKER_BUF = 64_000;
const STATE_DIR = ".shell_state";

let terminalManagerInstance: TerminalManager | null = null;

// ─── Internal types ──────────────────────────────────────────────────────────

interface PendingCommand {
  marker: string;
  markerBuf: string;
  onComplete: (exitCode: number | undefined, diagnostic?: string) => void;
}

interface ShellSession {
  id: string;
  poolKey: string;
  baseAgentId: string;
  process: ChildProcess;
  shellPath: string;
  pending: PendingCommand | null;
  queueTail: Promise<void>;
  terminalIds: Set<string>;
  spawnError?: Error;
  stderrTail: string;
}

// ─── Singleton helpers ───────────────────────────────────────────────────────

export function initTerminalManager(): TerminalManager {
  if (!terminalManagerInstance) {
    terminalManagerInstance = new TerminalManager();
  }
  return terminalManagerInstance;
}

export function getTerminalManager(): TerminalManager {
  if (!terminalManagerInstance) terminalManagerInstance = new TerminalManager();
  return terminalManagerInstance;
}

/** Test-only. */
export function resetTerminalManager(): void {
  terminalManagerInstance?.cleanup(0);
  terminalManagerInstance = null;
}

// ─── TerminalManager ─────────────────────────────────────────────────────────

export class TerminalManager implements TerminalManagerAPI {
  private terminals = new Map<string, TerminalInstance>();
  private sharedShells = new Map<string, ShellSession>();
  private sessions = new Map<string, ShellSession>();
  // Reverse index: terminalId → owning ShellSession. Used by kill() to skip
  // the previous O(sessions) `[...values()].find(...)` lookup. Maintained at
  // the same call sites as session.terminalIds.add/delete.
  private terminalToSession = new Map<string, ShellSession>();
  private terminalCounter = 0;
  private sessionCounter = 0;

  private completionWaiters = new Map<string, Array<() => void>>();
  private initPromise: Promise<void> | null = null;
  private _ready = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  isReady(): boolean { return this._ready; }

  async ensureReady(): Promise<void> {
    if (this._ready) return;
    await this.init();
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = Promise.resolve().then(() => {
      this._ready = true;
      // Periodic GC of finished terminals + their log files. Without this,
      // `this.terminals` grows unbounded over a long-lived server (every
      // exec adds; nothing removes). 60s cadence + .unref() so the timer
      // never holds the event loop open.
      if (!this.cleanupTimer) {
        this.cleanupTimer = setInterval(() => {
          try { this.cleanup(); } catch { /* keep timer alive */ }
        }, 60_000);
        this.cleanupTimer.unref?.();
      }
    });
    return this.initPromise;
  }

  // ─── Path helpers ──────────────────────────────────────────────────────────

  /** Terminal log 目录：
   *    有 agentId（agentPath）→ `<user>/terminals/<agentPath-with-slash-replaced>/`
   *    无 agentId          → `<user>/terminals/`
   *  PathManager 当前无 `terminalsDir()`，先用 user.cacheDir() 下的 terminals/ 子目录。 */
  private logDirFor(agentId: string | undefined): string {
    const base = join(getPathManager().user().cacheDir(), "terminals");
    if (!agentId) return base;
    return join(base, agentId.split("/").join("__"));
  }

  private stateDirFor(agentId: string | undefined): string {
    return join(this.logDirFor(agentId), STATE_DIR);
  }

  private cwdFile(agentId: string | undefined): string {
    return join(this.stateDirFor(agentId), "cwd");
  }

  // ─── Shell session management ──────────────────────────────────────────────

  private resolveShellPath(): string {
    // Prefer bash: the wrapped command (buildWrappedCommand) and the agent's
    // own commands are written in bash syntax. On macOS $SHELL is zsh, whose
    // different semantics (NOMATCH aborts an unmatched glob instead of passing
    // the literal; no `--norc`) make those commands fail with spurious exit 1
    // and `no matches found`. So $SHELL is only a last-resort fallback when no
    // bash is on disk; noRcFlags still picks correct flags for it if so.
    const candidates = [
      "/usr/bin/bash",
      "/bin/bash",
      "bash",
      process.env.SHELL,
    ].filter((v): v is string => Boolean(v));
    for (const c of candidates) {
      if (!c.includes("/")) return c;
      if (existsSync(c)) return c;
    }
    return "bash";
  }

  private resolveSessionCwd(initialCwd?: string): string {
    if (!initialCwd) return process.cwd();
    try {
      if (statSync(initialCwd).isDirectory()) return initialCwd;
    } catch { /* stale */ }
    return process.cwd();
  }

  /** Non-interactive startup flags differ per shell. bash/sh accept
   *  `--norc --noprofile`; zsh rejects `--norc` (`no such option: norc`) and
   *  uses `-f` (NO_RCS) instead; unknown shells get no flags. Picking by the
   *  RESOLVED shell — not assuming bash — is what stops every command failing
   *  with `zsh: no such option: norc` on macOS where $SHELL defaults to zsh. */
  private noRcFlags(shellPath: string): string[] {
    const base = shellPath.replace(/.*\//, "");
    if (base === "zsh") return ["-f"];
    if (base === "bash" || base === "sh") return ["--norc", "--noprofile"];
    return [];
  }

  private spawnShellProcess(shellPath: string, sessionCwd: string): ChildProcess {
    return spawn(shellPath, this.noRcFlags(shellPath), {
      cwd: sessionCwd,
      env: { ...process.env, PS1: "", PS2: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private attachSessionObservers(poolKey: string, session: ShellSession): void {
    const child = session.process;

    child.stdout?.on("data", (data: Buffer) => {
      if (!session.pending) return;
      session.pending.markerBuf += data.toString("utf-8");
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
        cb(undefined, this.buildFailureDiagnostic(session, "spawn_error"));
      }
      this.cleanupSession(poolKey, session);
    });

    child.on("exit", (code) => {
      if (session.pending) {
        const cb = session.pending.onComplete;
        session.pending = null;
        cb(code ?? 1, this.buildFailureDiagnostic(session, "shell_exit", code ?? 1));
      }
      this.cleanupSession(poolKey, session);
    });
  }

  private buildFailureDiagnostic(session: ShellSession, reason: "spawn_error" | "shell_exit", exitCode?: number): string {
    const lines = ["", `[shell session failed: ${reason}]`];
    if (typeof exitCode === "number") lines.push(`session_exit_code: ${exitCode}`);
    if (session.spawnError?.message) lines.push(`spawn_error: ${session.spawnError.message}`);
    const stderr = session.stderrTail.trim();
    if (stderr) lines.push("", "[shell stderr]", stderr);
    return lines.join("\n") + "\n";
  }

  private async createSession(baseAgentId: string, poolKey: string, initialCwd?: string, initScript?: string): Promise<ShellSession> {
    const shellPath = this.resolveShellPath();
    const sessionCwd = this.resolveSessionCwd(initialCwd);
    const child = this.spawnShellProcess(shellPath, sessionCwd);

    const session: ShellSession = {
      id: `s${++this.sessionCounter}-${Date.now()}`,
      poolKey,
      baseAgentId,
      process: child,
      shellPath,
      pending: null,
      queueTail: Promise.resolve(),
      terminalIds: new Set(),
      stderrTail: "",
    };

    this.attachSessionObservers(poolKey, session);

    if (initScript) {
      try { session.process.stdin?.write(initScript + "\n"); } catch { /* ignore */ }
    }

    this.sessions.set(session.id, session);
    return session;
  }

  private cleanupSession(poolKey: string, session: ShellSession): void {
    if (this.sharedShells.get(poolKey) === session) {
      this.sharedShells.delete(poolKey);
    }
    this.sessions.delete(session.id);
  }

  /** Drop an agent's "sticky" working directory so the next `exec` starts in a
   *  freshly-resolved cwd (used when the active game changes — the cli must
   *  follow the new .forgeax/games/<slug>/ rather than wherever the long-lived
   *  shell last `cd`'d to).
   *
   *  Sticky cwd has three layers, all cleared here:
   *    1. persisted `.shell_state/cwd` file (survives restarts → `cd` on respawn);
   *    2. the cached long-lived bash process (poolKey `<agentId>:host`);
   *  The third layer — the in-memory blackboard CURRENT_DIR — is the caller's
   *  responsibility (it owns the Session/Blackboard), since the manager has no
   *  blackboard handle. With CURRENT_DIR repointed + this reset, the next exec's
   *  `initialCwd` resolves to the new game dir on a brand-new shell.
   *
   *  If a command is mid-flight we detach the cached session (so the next exec
   *  spawns a fresh shell) but let the running command finish rather than
   *  killing it out from under the agent. */
  async resetAgentCwd(agentId: string | undefined): Promise<void> {
    try { await unlink(this.cwdFile(agentId)); } catch { /* no persisted state */ }
    const poolKey = `${agentId ?? ""}:host`;
    const session = this.sharedShells.get(poolKey);
    if (!session) return;
    this.sharedShells.delete(poolKey);
    if (!session.pending) {
      try { session.process.kill(); } catch { /* already gone */ }
    }
  }

  private async getOrCreateSharedShell(agentId: string | undefined, initialCwd?: string): Promise<ShellSession> {
    const baseAgentId = agentId ?? "";
    const poolKey = `${baseAgentId}:host`;
    const existing = this.sharedShells.get(poolKey);
    if (existing && existing.process.exitCode === null) return existing;

    let initScript: string | undefined;
    try {
      const savedCwd = (await readFile(this.cwdFile(agentId), "utf-8")).trim();
      if (savedCwd) initScript = `cd ${shellQuote(savedCwd)} 2>/dev/null || true`;
    } catch { /* no state */ }

    const session = await this.createSession(baseAgentId, poolKey, initialCwd, initScript);
    this.sharedShells.set(poolKey, session);
    return session;
  }

  private enqueueSessionTurn(session: ShellSession): { waitTurn: Promise<void>; releaseTurn: () => void } {
    const waitTurn = session.queueTail.catch(() => undefined);
    let resolveTurn!: () => void;
    let released = false;
    const myTurn = new Promise<void>((resolve) => { resolveTurn = resolve; });
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

  private async acquireQueuedSession(agentId: string | undefined, initialCwd?: string): Promise<{ session: ShellSession; releaseTurn: () => void }> {
    while (true) {
      const session = await this.getOrCreateSharedShell(agentId, initialCwd);
      const { waitTurn, releaseTurn } = this.enqueueSessionTurn(session);
      await waitTurn;
      if (this.sharedShells.get(session.poolKey) !== session || session.process.exitCode !== null) {
        releaseTurn();
        continue;
      }
      return { session, releaseTurn };
    }
  }

  // ─── exec ──────────────────────────────────────────────────────────────────

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const logDir = this.logDirFor(opts.agentId);
    const stDir = this.stateDirFor(opts.agentId);
    await mkdir(logDir, { recursive: true });
    await mkdir(stDir, { recursive: true });

    const id = `t${++this.terminalCounter}-${Date.now()}`;
    const descSlug = opts.description ? `-${slugify(opts.description)}` : "";
    const logFile = join(logDir, `${id}${descSlug}.txt`);
    const marker = `__MCEND_${id}__`;
    const startedAt = Date.now();
    const cwdF = this.cwdFile(opts.agentId);

    if (opts.signal?.aborted) {
      return { terminalId: id, logFile, stdout: "[aborted]", backgrounded: false };
    }

    let acquired: { session: ShellSession; releaseTurn: () => void } | null = null;
    if (opts.signal) {
      const acquirePromise = this.acquireQueuedSession(opts.agentId, opts.initialCwd);
      const abortPromise = new Promise<null>((resolve) => {
        opts.signal!.addEventListener("abort", () => resolve(null), { once: true });
      });
      const result = await Promise.race([acquirePromise, abortPromise]);
      if (result === null) {
        return { terminalId: id, logFile, stdout: "[aborted before execution]", backgrounded: false };
      }
      acquired = result;
    } else {
      acquired = await this.acquireQueuedSession(opts.agentId, opts.initialCwd);
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
    this.terminalToSession.set(id, session);

    if (session.spawnError || !session.process.stdin) {
      releaseTurn();
      const msg = `Shell unavailable (${session.shellPath}): ${session.spawnError?.message ?? "spawn failure"}`;
      instance.exitCode = 127;
      instance.elapsedMs = 0;
      await this.writeLog(instance, msg, true);
      return { terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false };
    }

    await this.writeLog(instance, "", false);
    const wrapped = buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt });

    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const effectiveTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;

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

      if (opts.signal) {
        const onAbort = () => {
          if (settled) return;
          try { process.kill(-session.process.pid!, "SIGINT"); } catch {
            try { session.process.stdin?.write("\x03"); } catch { /* ignore */ }
          }
          backgroundAndSettle("[aborted by steer]", `Command was interrupted. Partial output: ${logFile}`);
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

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
        onComplete: async (exitCode, diagnostic) => {
          if (timer) clearTimeout(timer);
          session.terminalIds.delete(id);
          this.terminalToSession.delete(id);
          instance.exitCode = exitCode;
          instance.elapsedMs = Date.now() - startedAt;
          releaseTurn();
          this.notifyCompletionWaiters(id);

          if (diagnostic) {
            const footer = [
              "", "---",
              `exit_code: ${instance.exitCode ?? "unknown"}`,
              `elapsed_ms: ${instance.elapsedMs}`,
              "---", "",
            ].join("\n");
            await appendFile(logFile, diagnostic + footer, "utf-8").catch(() => {});
          }

          if (!settled) {
            settled = true;
            const body = await readLogBody(logFile);
            let postCwd: string | undefined;
            try { postCwd = (await readFile(cwdF, "utf-8")).trim() || undefined; } catch { /* none */ }
            resolve({ terminalId: id, logFile, stdout: body, exitCode, backgrounded: false, cwd: postCwd });
          }
        },
      };

      try {
        session.process.stdin!.write(wrapped);
      } catch (err) {
        if (timer) clearTimeout(timer);
        session.terminalIds.delete(id);
        this.terminalToSession.delete(id);
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

  // ─── Completion-waiter plumbing ────────────────────────────────────────────

  private notifyCompletionWaiters(terminalId: string): void {
    const waiters = this.completionWaiters.get(terminalId);
    if (!waiters) return;
    this.completionWaiters.delete(terminalId);
    for (const w of waiters) { try { w(); } catch { /* ignore */ } }
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

  // ─── TerminalManagerAPI ────────────────────────────────────────────────────

  get(id: string): TerminalInstance | undefined { return this.terminals.get(id); }

  list(filter?: { agentId?: string; status?: string }): TerminalInstance[] {
    const result: TerminalInstance[] = [];
    for (const [, t] of this.terminals) {
      if (filter?.agentId && t.agentId !== filter.agentId) continue;
      if (filter?.status === "running" && t.exitCode !== undefined) continue;
      if (filter?.status === "done" && t.exitCode === undefined) continue;
      result.push(t);
    }
    return result;
  }

  kill(id: string): boolean {
    const session = this.terminalToSession.get(id);
    if (!session || session.process.exitCode !== null) return false;
    try {
      process.kill(-session.process.pid!, "SIGINT");
      return true;
    } catch {
      try { session.process.stdin!.write("\x03"); return true; } catch { return false; }
    }
  }

  async wait(terminalId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const instance = this.terminals.get(terminalId);
    if (!instance) return { terminalId, status: "not_found", stdout: "", logFile: "" };

    if (instance.exitCode !== undefined) {
      return {
        terminalId, status: "done",
        exitCode: instance.exitCode,
        elapsedMs: instance.elapsedMs,
        stdout: await readLogBody(instance.logFile),
        logFile: instance.logFile,
      };
    }
    if (timeoutMs <= 0 || signal?.aborted) {
      return {
        terminalId, status: "still_running",
        stdout: await readLogBody(instance.logFile),
        logFile: instance.logFile,
      };
    }

    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let removeWaiter: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

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
          terminalId, status: "done",
          exitCode: instance.exitCode, elapsedMs: instance.elapsedMs,
          stdout: await readLogBody(instance.logFile),
          logFile: instance.logFile,
        });
      };

      const finishStillRunning = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          terminalId, status: "still_running",
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
      this.terminalToSession.clear();
      this.completionWaiters.clear();
      if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
      this._ready = false;
      this.initPromise = null;
    }
    const cutoff = Date.now() - (maxAge ?? 3_600_000);
    for (const [id, t] of this.terminals) {
      if (t.exitCode !== undefined && t.startedAt < cutoff) {
        this.terminals.delete(id);
        this.terminalToSession.delete(id);
        unlink(t.logFile).catch(() => {});
      }
    }
  }

  // ─── Log helpers ───────────────────────────────────────────────────────────

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
      "---", "",
    ].join("\n");

    if (finished) {
      const footer = [
        "", "---",
        `exit_code: ${instance.exitCode ?? "unknown"}`,
        `elapsed_ms: ${instance.elapsedMs ?? Date.now() - instance.startedAt}`,
        "---",
      ].join("\n");
      await writeFile(instance.logFile, header + body + footer).catch(() => {});
    } else {
      await writeFile(instance.logFile, header).catch(() => {});
    }
  }

  // ─── execSync ──────────────────────────────────────────────────────────────

  execSync(command: string, args: string[], opts?: ExecSyncOpts): string {
    const cwd = opts?.cwd;
    const timeout = opts?.timeout ?? 30_000;
    const input = opts?.input;
    const extraEnv = opts?.env;
    const mergedEnv = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    const result = spawnSync(command, args, {
      cwd, env: mergedEnv, encoding: "utf-8", timeout, input,
    });
    if (result.status !== 0) {
      const err = new Error(result.stderr?.trim() || `${command} ${args[0] ?? ""} failed (code ${result.status})`);
      (err as any).stderr = result.stderr;
      throw err;
    }
    return (result.stdout ?? "").trim();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface WrapOpts {
  command: string;
  opts: ExecOpts;
  logFile: string;
  cwdF: string;
  marker: string;
  startedAt: number;
}

function buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt }: WrapOpts): string {
  let cmd = command;
  if (opts.cwd) cmd = `cd ${shellQuote(opts.cwd)} && { ${cmd} ; }`;
  const quoted = evalQuote(cmd);
  return [
    `{ eval ${quoted}; __mc_rc=$?; } < /dev/null >> ${shellQuote(logFile)} 2>&1 || __mc_rc=$?`,
    `pwd > ${shellQuote(cwdF)} 2>/dev/null || true`,
    `printf '\\n---\\nexit_code: '%s'\\nelapsed_ms: '%s'\\n---\\n' "$__mc_rc" "$(($(date +%s%3N) - ${startedAt}))" >> ${shellQuote(logFile)} 2>/dev/null || true`,
    `echo ""`,
    `echo "${marker} $__mc_rc"`,
  ].join("\n") + "\n";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function evalQuote(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

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

async function readLogBody(logFile: string): Promise<string> {
  try {
    const raw = await readFile(logFile, "utf-8");
    const headerEnd = raw.indexOf("\n---\n", raw.indexOf("---\n") + 4);
    const body = headerEnd !== -1 ? raw.slice(headerEnd + 5) : raw;
    return body.slice(0, MAX_STDOUT_CAPTURE);
  } catch {
    return "";
  }
}
