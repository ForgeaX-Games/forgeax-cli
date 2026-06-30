/** sandbox/terminal —— PTY-backed 进程 spawn 接口预留。
 *
 *  本轮（C10）**只留 interface，不实现 body**。ConsciousAgent / tool 层未来要给
 *  agent 一个长连接 shell（执行交互式命令、tail logs、热重载脚本）时统一走这个
 *  抽象，避免直接绑定 `node-pty` / `child_process`。
 *
 *  实现何时落地：
 *  - cwd access point: `agentContext.cwd` carries game root resolved from
 *    `session.config.defaultDir` at agent boot (bug-20260522). Terminal shell
 *    sessions via `src/terminal/manager.ts` accept `initialCwd` on `exec()`.
 *  - Sandbox container routing (docker exec / dockerode) is future sandbox
 *    stage (OOS-3). One TerminalManager per sandboxRef (game-project
 *    container), multiple TerminalHandle sharing the underlying container.
 *  - Top-level Session does not hold TerminalManager; SandboxManager pools
 *    per defaultDir, same source as FsBridge.
 *
 *  与 agenteam ref 的差异：
 *  - ref 的 `core/terminal/` 子树（registry / multi-shell coordinator / FSWatcher
 *    联动）不带过来 —— forgeax 的 fs hot reload 是 game-project 内部事务，runtime
 *    层不参与。
 *  - 不挂 channel-side terminal renderer（ink 之类）；那是 packages/cli 的事。 */

// ─── 类型 ─────────────────────────────────────────────────────────────────

export interface SpawnOpts {
  /** Working directory inside the sandbox. Defaults to instance root. */
  cwd?: string;
  /** Environment variables overlay. */
  env?: Record<string, string>;
  /** PTY initial column / row. Implementations may pass to setWindowSize. */
  cols?: number;
  rows?: number;
  /** Container user override; defaults to non-privileged HOST_USER. */
  user?: string;
  /** Abort signal — kills the child & releases the PTY when raised. */
  signal?: AbortSignal;
}

export interface TerminalHandle {
  /** Stable id within this TerminalManager. */
  readonly id: string;
  /** OS pid of the spawned process (or container-side pid for docker exec). */
  readonly pid: number;
  /** Push bytes to stdin. */
  write(data: string | Uint8Array): void;
  /** Resize the PTY. */
  resize(cols: number, rows: number): void;
  /** Subscribe to combined stdout/stderr stream. */
  onData(handler: (chunk: Uint8Array) => void): () => void;
  /** Resolved when the process exits, with the exit status. */
  exit(): Promise<{ code: number; signal: string | null }>;
  /** Force-kill the process and release the PTY. */
  kill(signal?: NodeJS.Signals): void;
}

// ─── TerminalManager 接口（plan §3.12）─────────────────────────────────────

/** 给 ConsciousAgent / tool 实现 spawn 长连接进程用的统一出口。
 *
 *  实现（后续 sandbox stage 落地）：spawn 在 sandbox 容器里跑（docker exec -it
 *  + node-pty），未启用 sandbox 时降级宿主机 PTY；handle 回调和 abort signal
 *  保持在同一进程内（无 IPC 序列化成本）。 */
export interface TerminalManager {
  /** Spawn a PTY-backed process. */
  spawn(cmd: string, args: string[], opts?: SpawnOpts): Promise<TerminalHandle>;
  /** List currently-alive handles managed by this instance. */
  list(): TerminalHandle[];
  /** Kill all handles and release the PTY pool. */
  shutdown(): Promise<void>;
}
