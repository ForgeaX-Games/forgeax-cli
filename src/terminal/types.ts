/** Terminal Manager types — instance, exec options, result. */

export interface TerminalInstance {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  /** undefined means it is a system-level terminal */
  agentId?: string;
  startedAt: number;
  backgrounded?: boolean;
  exitCode?: number;
  elapsedMs?: number;
  logFile: string;
}

/** Shared options for both sync and async command execution. */
export interface ExecBaseOpts {
  cwd?: string;
  /** Additional env vars. In Docker mode these become --env K=V args. */
  env?: Record<string, string>;
  /** Data piped to stdin (e.g. commit message for git commit-tree). */
  input?: string;
  /** Timeout in ms. Default: 30000. If <= 0, runs indefinitely. */
  timeout?: number;
}

/** Options for async exec() — persistent session, log files, agent context. */
export interface ExecOpts extends ExecBaseOpts {
  /** Only applied when a brand-new bash session is created (e.g. after timeout/background).
   *  Has no effect if an existing session is reused — preserving the model's own cd state. */
  initialCwd?: string;
  /** If empty or undefined, runs the command in a system-level terminal instead of a agent-level user terminal. */
  agentId?: string;
  /** Short description included in the log filename for easy identification. */
  description?: string;
  /** If provided, aborting the signal will SIGINT the foreground process and resolve immediately. */
  signal?: AbortSignal;
  /** Explicit execution environment. "host" = always host; "container" = always container.
   *  Omit to auto-determine (container when sandbox enabled, host otherwise). */
  environmentKey?: "host" | "container";
}

/** Options for sync execSync() — one-shot, lightweight. */
export interface ExecSyncOpts extends ExecBaseOpts {
  /**
   * Docker 模式下 `docker exec --user` 的身份选择。
   * - `false`（默认）→ 宿主 `uid:gid`，文件落盘直接归属宿主用户
   * - `true` → `root`，仅限需要写 `/etc` 或容器系统目录的受信调用
   *
   * 绝大多数 agent/plugin 调用都应保持默认值——在 bind-mount 的 instance 目录上
   * 跑 git / CLI 不应以 root 身份写入，否则会在宿主产生 root-owned 残留。
   */
  privileged?: boolean;
}

export interface TerminalManagerAPI {
  /** 幂等初始化：下载独立 Python/Node、检测 unshare 可用性。多次调用复用同一 Promise。 */
  init(): Promise<void>;
  /** 同步查询初始化是否已完成。 */
  isReady(): boolean;
  /** 异步等待初始化完成；若尚未初始化则自动调用 init() 并等待完成。 */
  ensureReady(): Promise<void>;
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  /**
   * Synchronous one-shot command execution, auto-routing through sandbox.
   * Docker mode: docker exec -i --user <resolveContainerUser> --workdir cwd containerName command ...args
   * Direct mode: spawnSync(command, args, { cwd, env, ... })
   * Returns stdout string; throws on non-zero exit code.
   */
  execSync(command: string, args: string[], opts?: ExecSyncOpts): string;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { agentId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  /**
   * Wait for an existing terminal (typically backgrounded) to finish, with a hard deadline.
   *
   * Behavior:
   * - Terminal already finished → resolve immediately with `status: "done"` + exitCode + stdout.
   * - Finishes within `timeoutMs` → early-resolve with full result.
   * - Still running at deadline → resolve with `status: "still_running"` + current stdout snapshot;
   *   caller may call `wait()` again with the same terminalId to keep waiting.
   * - `signal` aborts → resolve with current snapshot (does NOT kill the command).
   * - Unknown terminalId → resolve with `status: "not_found"`.
   */
  wait(terminalId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>;
  cleanup(maxAge?: number): void;
  loadSystemEnv(): Promise<void>;
  loadAgentEnv(agentId: string): Promise<void>;
}

export interface ExecResult {
  terminalId: string;
  logFile: string;
  stdout: string;
  exitCode?: number;
  backgrounded: boolean;
  hint?: string;
  /** Post-execution working directory read from the persistent cwd state file. */
  cwd?: string;
}

/** Result of TerminalManagerAPI.wait() — see its JSDoc for the status semantics. */
export interface WaitResult {
  terminalId: string;
  status: "done" | "still_running" | "not_found";
  logFile: string;
  /** Stdout captured so far (full body when done; snapshot when still_running). */
  stdout: string;
  /** Set when status === "done". */
  exitCode?: number;
  elapsedMs?: number;
}
