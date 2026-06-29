/** sandbox/fs-bridge —— ConsciousAgent / tool 层访问 game-project 容器内 fs 的统一出口。
 *
 *  本轮（C10）**只留 interface + 类型签名，不实现 body**。后续 sandbox 阶段（与
 *  game-project / docker exec 一起做）填充 docker-cli 路由 + bind-mount 快路径。
 *
 *  设计原则（plan §3.12）：
 *  - ConsciousAgent / tool 实现**不直接调** `node:fs` / `node:child_process` 触达
 *    game-project，而是统一走 `FsBridge`。
 *  - sandbox 不挂在 Session 上 —— 由 SandboxManager 按 `SessionConfig.defaultDir`
 *    池化共享；first tool exec 时 lazy `SandboxManager.acquire(slug)`。
 *  - 路径模型与 agenteam 保持一致（容器视角绝对路径），路由细节（bind-mount 快路径
 *    vs docker exec）是实现内部事务，对调用方不可见。
 *
 *  另外保留 `sandboxFs` 这个轻量同模块导出 —— 给 LLM 层的 `media-storage.ts` /
 *  `gemini-shared.ts` 在 *没有* sandbox 实现时降级用宿主机 fs 直读 inline media bytes。
 *  当真正的 sandbox 实现接进来后，这个 const 会被替换成 `createFsBridge(sandboxRef)`
 *  的 `readBinary` 投影。 */

import { readFile } from "node:fs/promises";

// ─── 数据类型 ─────────────────────────────────────────────────────────────

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ExecOpts {
  /** Working directory inside the sandbox. Defaults to instance root. */
  cwd?: string;
  /** Environment variables overlay (merged on top of the sandbox's default env). */
  env?: Record<string, string>;
  /** stdin payload to feed the process. */
  input?: Buffer | string;
  /** Total wall-clock timeout (ms). Implementation kills the process on overrun. */
  timeoutMs?: number;
  /** Override container user; defaults to the non-privileged HOST_USER. */
  user?: string;
  /** Don't throw on non-zero exit; return the result instead. */
  allowFailure?: boolean;
  /** Abort signal — implementation should propagate to the spawned child. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export interface GrepOptions {
  caseInsensitive?: boolean;
  contextLines?: number;
  outputMode?: "content" | "files_with_matches" | "count";
  glob?: string;
  multiline?: boolean;
}

// ─── FsBridge 接口（plan §3.12）─────────────────────────────────────────────
//
// 给 ConsciousAgent / tool 实现使用。Session 层在 first tool exec 时调
// `SandboxManager.acquire(defaultDir)` 拿到一份 FsBridge 实现。

/** Sandbox 文件系统桥接 —— 屏蔽 host fs / docker exec 路由细节。
 *
 *  实现（后续 sandbox stage 落地）需要满足：
 *  - 路径一律是容器视角绝对路径；调用方不要传相对路径。
 *  - bind-mount 路径走 host fs 快路径，其余走 `docker exec`，对调用方透明。
 *  - 容器不可达时抛 `containerUnavailable` 标记错误，由 caller 决定降级。 */
export interface FsBridge {
  /** Read raw bytes. */
  read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  /** Read as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Write raw bytes (auto mkdir -p of parent). */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Write UTF-8 text (auto mkdir -p of parent). */
  writeText(path: string, content: string): Promise<void>;
  /** Stat. Returns null when path does not exist. */
  stat(path: string): Promise<FsStat | null>;
  /** Existence probe. */
  exists(path: string): Promise<boolean>;
  /** List directory entries (alphabetical). */
  list(path: string): Promise<DirEntry[]>;
  /** mkdir -p. */
  mkdir(path: string): Promise<void>;
  /** Remove. recursive: rm -rf, force: rm -f. */
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** Rename / move. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Glob file search rooted at `baseDir` (excludes node_modules / .git / dist). */
  glob(baseDir: string, pattern: string): Promise<string[]>;
  /** Grep — auto-routes ripgrep/grep on host vs grep -E inside container. */
  grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string>;
  /** Spawn a command and collect stdout/stderr/code. */
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
}

// ─── 临时 sandboxFs stub —— LLM 层 inline-media 降级路径 ─────────────────────

/** Sandbox 实现尚未接入前，LLM 层（`media-storage.ts` / `gemini-shared.ts`）需要
 *  把 ContentPart 的 inline media bytes 读成 Buffer 喂给 provider；此时直接走宿主
 *  机 fs。等 sandbox 实现进来后，这个 const 会被 SandboxManager 在启动时替换成
 *  绑定到 sandboxRef 的真实 FsBridge.read 投影。 */
export const sandboxFs = {
  async readBinary(path: string): Promise<Buffer> {
    return await readFile(path);
  },
};

// ─── AgentFsAPI ── CWD 感知的 per-agent fs view ────────────────────────────
//
// 挂载在 AgentContext.fs 上供工具调用。
//
// 当前实现：`src/fs/agent-fs.ts` 直读宿主机 fs（不经过 FsBridge）。
// `createAgentFs` fallback chain now consumes `sessionCwd` as its top
// priority (bug-20260522). Sandbox docker exec routing remains future
// sandbox stage work (OOS-3), at which point `createAgentFs` will add a
// `needsProxy(path)` branch.
//
// 类型源依旧在 `src/fs/agent-fs.ts`，这里仅做 re-export 让 sandbox 模块
// 也能直接拿到（避免 sandbox -> fs 反向 import）。

export type { AgentFsAPI } from "../fs/agent-fs";
