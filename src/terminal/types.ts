/** TerminalManager type contracts.
 *
 *  当前实现为「宿主机直跑 bash session」。sandbox 启用后会按
 *  SessionConfig.defaultDir 指向的 game-project 容器路由 docker exec，接口对
 *  caller 不变（详见 src/terminal/manager.ts 顶部注释）。 */

export interface TerminalInstance {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  /** undefined = system-level terminal（非 agent 触发的 plumbing 调用）。 */
  agentId?: string;
  startedAt: number;
  backgrounded?: boolean;
  exitCode?: number;
  elapsedMs?: number;
  logFile: string;
}

export interface ExecBaseOpts {
  cwd?: string;
  /** 额外环境变量（sandbox 启用后转换为 `--env K=V`）。 */
  env?: Record<string, string>;
  /** stdin 注入（如 git commit-tree 的消息）。 */
  input?: string;
  /** 超时（ms），默认 30000；<=0 表示永不超时。 */
  timeout?: number;
}

export interface ExecOpts extends ExecBaseOpts {
  /** 新建 session 时的初始 cwd；复用已存在 session 不生效（保留模型的 cd 状态）。 */
  initialCwd?: string;
  agentId?: string;
  description?: string;
  signal?: AbortSignal;
}

export interface ExecSyncOpts extends ExecBaseOpts {}

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

export interface WaitResult {
  terminalId: string;
  status: "done" | "still_running" | "not_found";
  logFile: string;
  stdout: string;
  exitCode?: number;
  elapsedMs?: number;
}

export interface TerminalManagerAPI {
  init(): Promise<void>;
  isReady(): boolean;
  ensureReady(): Promise<void>;
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  execSync(command: string, args: string[], opts?: ExecSyncOpts): string;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { agentId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  wait(terminalId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>;
  cleanup(maxAge?: number): void;
}
