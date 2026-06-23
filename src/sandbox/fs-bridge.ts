/**
 * fs-bridge — 容器文件系统桥接层。
 *
 * 路由模型：
 *
 *   1. sandbox 未启用 → 全部 host fs（direct 模式）
 *   2. sandbox 启用 + 路径在 instance root 下（bind-mount :rw，同路径映射）
 *      → 直接走 host fs（跳过 docker exec，大幅减少延迟）
 *      例外：node_modules/ 被 tmpfs 覆盖，仍需 docker exec
 *   3. sandbox 启用 + 路径在 instance root 外（SSHFS / 容器独有路径）
 *      → docker exec
 *
 * 所有容器内操作通过 `docker exec sh -c 'script' sh "$@"` 的参数安全模式执行。
 */

import { spawn, execFile, spawnSync } from "node:child_process";
import { normalize, sep, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { readFile, writeFile, open, stat as fsStat, readdir, mkdir } from "node:fs/promises";
import {
  existsSync as nodeExistsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
} from "node:fs";
import { getSandboxManager } from "./manager.js";
import { TEAMBOARD_KEYS } from "../defaults/teamboard-vars.js";
import { resolveContainerUser } from "./user-resolver.js";
import { getPathManager } from "../fs/path-manager.js";
import type { PathManagerAPI, TeamBoardAPI } from "../core/types.js";

// ─── 底层 docker exec 原语 ────────────────────────────────────────────────────

type DockerExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

/**
 * 执行 docker exec，收集完整 stdout/stderr，支持 stdin 注入。
 */
function execDockerRaw(
  args: string[],
  opts?: { input?: Buffer | string; allowFailure?: boolean },
): Promise<DockerExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        const msg = stderr.length ? stderr.toString("utf-8").trim() : `docker exec failed (code ${exitCode})`;
        reject(Object.assign(new Error(msg), { code: exitCode, stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    if (opts?.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 在容器内执行 shell 脚本，通过 $1/$2/... 传递参数，避免字符串注入。
 * 使用 `sh -c 'script' sh "$@"` 惯例（argv[0] = "sh"）。
 */
async function runInContainer(
  containerName: string,
  script: string,
  args: string[] = [],
  opts?: { input?: Buffer | string; allowFailure?: boolean; user?: string },
): Promise<DockerExecResult> {
  const userArgs = opts?.user ? ["--user", opts.user] : [];
  const dockerArgs = ["exec", "-i", ...userArgs, containerName, "sh", "-c", script, "sh", ...args];
  return execDockerRaw(dockerArgs, opts);
}

// ─── 同步容器原语 ─────────────────────────────────────────────────────────────

type DockerExecSyncResult = { stdout: Buffer; stderr: Buffer; code: number };

/**
 * 同步版 runInContainer — 用 spawnSync 执行 docker exec，原生阻塞。
 * 不做容器恢复（sync 场景不合理），失败直接抛错。
 */
function runInContainerSync(
  containerName: string,
  script: string,
  args: string[] = [],
  opts?: { input?: Buffer | string; allowFailure?: boolean; user?: string },
): DockerExecSyncResult {
  const userArgs = opts?.user ? ["--user", opts.user] : [];
  const dockerArgs = ["exec", "-i", ...userArgs, containerName, "sh", "-c", script, "sh", ...args];
  const result = spawnSync("docker", dockerArgs, {
    input: opts?.input !== undefined ? (typeof opts.input === "string" ? Buffer.from(opts.input) : opts.input) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  const code = result.status ?? 1;
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (code !== 0 && !opts?.allowFailure) {
    const msg = stderr.length ? stderr.toString("utf-8").trim() : `docker exec sync failed (code ${code})`;
    throw Object.assign(new Error(msg), { code, stdout, stderr });
  }
  return { stdout, stderr, code };
}

// ─── 容器文件系统操作 API ─────────────────────────────────────────────────────

function _containerName(): string {
  return getSandboxManager()!.getContainerName();
}

/** @internal 读取容器内文本文件 */
async function containerReadText(absPath: string, user?: string): Promise<string> {
  const result = await runInContainer(_containerName(), 'set -eu; cat -- "$1"', [absPath], { user });
  return result.stdout.toString("utf-8");
}

/** @internal 读取容器内二进制文件 */
async function containerReadBinary(absPath: string, maxBytes?: number, user?: string): Promise<Buffer> {
  const script = maxBytes !== undefined
    ? 'set -eu; head -c "$2" -- "$1" | base64'
    : 'set -eu; base64 -- "$1"';
  const args = maxBytes !== undefined ? [absPath, String(maxBytes)] : [absPath];
  const result = await runInContainer(_containerName(), script, args, { user });
  return Buffer.from(result.stdout.toString("utf-8").replace(/\s/g, ""), "base64");
}

/** @internal 向容器内路径写入内容 */
async function containerWriteText(absPath: string, content: string, user?: string): Promise<void> {
  await runInContainer(
    _containerName(),
    'set -eu; dir=$(dirname -- "$1"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; cat > "$1"',
    [absPath],
    { input: content, user },
  );
}

/** @internal 列出容器内目录 */
async function containerListDir(absPath: string, user?: string): Promise<string[]> {
  const result = await runInContainer(
    _containerName(),
    'set -eu; for f in "$1"/.[!.]* "$1"/* ; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf "d\t%s\n" "$(basename -- "$f")"; else printf "f\t%s\n" "$(basename -- "$f")"; fi; done',
    [absPath],
    { allowFailure: true, user },
  );
  if (result.code !== 0 || !result.stdout.length) return [];
  return result.stdout
    .toString("utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const type = line.slice(0, tab);
      const name = line.slice(tab + 1);
      return type === "d" ? `[dir]  ${name}` : `[file] ${name}`;
    });
}

/** 在容器内用 find 做文件搜索，返回相对于 baseDir 的路径列表（已在 JS 侧做 glob 过滤） */
async function containerGlob(baseDir: string, pattern: string, user?: string): Promise<string[]> {
  const result = await runInContainer(
    _containerName(),
    'set -eu; find "$1" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -type f',
    [baseDir],
    { allowFailure: true, user },
  );
  if (result.code !== 0 || !result.stdout.length) return [];

  const base = normalize(baseDir);
  return result.stdout
    .toString("utf-8")
    .trim()
    .split("\n")
    .map((f) => {
      const norm = normalize(f);
      return norm.startsWith(base + sep) ? norm.slice(base.length + 1) : norm;
    })
    .filter((rel) => matchGlobPattern(pattern, rel));
}

export interface GrepOptions {
  caseInsensitive?: boolean;
  contextLines?: number;
  outputMode?: "content" | "files_with_matches" | "count";
  glob?: string;
  multiline?: boolean;
}

const GREP_TIMEOUT_MS = 15_000;
const GREP_SKIP_DIRS = ["node_modules", ".git", "dist", "__pycache__", ".cache"];

/** 在容器内用 grep -E 搜索文件内容 */
async function containerGrep(
  searchPath: string,
  pattern: string,
  opts: GrepOptions | undefined,
  user?: string,
): Promise<string> {
  const flags = ["-rn", "-I"];
  for (const d of GREP_SKIP_DIRS) flags.push(`--exclude-dir=${d}`);
  if (opts?.caseInsensitive) flags.push("-i");
  if (opts?.contextLines && opts.contextLines > 0) flags.push(`-C${opts.contextLines}`);
  if (opts?.outputMode === "files_with_matches") flags.push("-l");
  else if (opts?.outputMode === "count") flags.push("-c");

  const script = `set -eu; grep ${flags.join(" ")} -E -- "$2" "$1"`;
  const result = await runInContainer(
    _containerName(),
    script,
    [searchPath, pattern],
    { allowFailure: true, user },
  );
  return result.stdout.toString("utf-8");
}

/** 宿主机侧 grep：优先 ripgrep，fallback 到 grep -E */
async function hostGrep(
  searchPath: string,
  pattern: string,
  opts: GrepOptions | undefined,
): Promise<string> {
  const rgArgs = ["--no-heading", "--line-number", "--color=never"];
  if (opts?.caseInsensitive) rgArgs.push("-i");
  if (opts?.multiline) rgArgs.push("-U", "--multiline-dotall");
  if (opts?.outputMode === "files_with_matches") rgArgs.push("-l");
  else if (opts?.outputMode === "count") rgArgs.push("-c");
  else if (opts?.contextLines && opts.contextLines > 0) rgArgs.push(`-C${opts.contextLines}`);
  if (opts?.glob) rgArgs.push("--glob", opts.glob);
  for (const d of GREP_SKIP_DIRS) rgArgs.push("--glob", `!${d}`);
  rgArgs.push("--glob", "!.*");
  rgArgs.push("--max-count=500");
  rgArgs.push("--", pattern, searchPath);

  return new Promise<string>((resolve) => {
    execFile("rg", rgArgs, { timeout: GREP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as any).code === "ENOENT") {
        // rg not available — fall back to grep -E
        hostGrepFallback(searchPath, pattern, opts).then(resolve);
        return;
      }
      if (err && err.killed) {
        resolve(stdout + `\n\n[grep timed out after ${GREP_TIMEOUT_MS / 1000}s. Narrow your search.]`);
        return;
      }
      resolve(stdout || "");
    });
  });
}

/** Last-resort host grep using grep -rn -E (always available on Linux/macOS) */
async function hostGrepFallback(
  searchPath: string,
  pattern: string,
  opts: GrepOptions | undefined,
): Promise<string> {
  const flags = ["-rn", "-I", "-E"];
  for (const d of GREP_SKIP_DIRS) flags.push(`--exclude-dir=${d}`);
  if (opts?.caseInsensitive) flags.push("-i");
  if (opts?.contextLines && opts.contextLines > 0) flags.push(`-C${opts.contextLines}`);
  if (opts?.outputMode === "files_with_matches") flags.push("-l");
  else if (opts?.outputMode === "count") flags.push("-c");
  flags.push("--", pattern, searchPath);

  return new Promise<string>((resolve) => {
    execFile("grep", flags, { timeout: GREP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.killed) {
        resolve(stdout + `\n\n[grep timed out after ${GREP_TIMEOUT_MS / 1000}s. Narrow your search.]`);
        return;
      }
      resolve(stdout || "");
    });
  });
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function matchGlobPattern(pattern: string, path: string): boolean {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { re += "(?:.+/)?"; i += 3; }
      else { re += ".*"; i += 2; }
    } else if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === ".") { re += "\\."; i++; }
    else { re += c; i++; }
  }
  return new RegExp(`^${re}$`).test(path);
}

// ─── SandboxFs — 统一文件操作 API ─────────────────────────────────────────────
//
// 路由：sandbox 启用时，bind-mount 路径（instance root 下且非 node_modules/）走 host fs，
// 其余路径走 docker exec。sandbox 未启用时全部走 host fs。

export type FsStat = { isFile: boolean; isDirectory: boolean; size: number };

export interface SandboxFs {
  /** Whether the resolved path needs container proxy (runtime-aware). */
  needsProxy(absPath?: string): boolean;

  // async
  readText(absPath: string): Promise<string>;
  readBinary(absPath: string, maxBytes?: number): Promise<Buffer>;
  writeText(absPath: string, content: string): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  stat(absPath: string): Promise<FsStat | null>;
  listDir(absPath: string): Promise<string[]>;
  mkdir(absPath: string): Promise<void>;
  glob(baseDir: string, pattern: string): Promise<string[]>;
  grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string>;

  // sync — host: node:fs sync; container: spawnSync docker exec
  readTextSync(absPath: string): string;
  writeTextSync(absPath: string, content: string): void;
  writeBinarySync(absPath: string, data: Buffer): void;
  appendTextSync(absPath: string, content: string): void;
  existsSync(absPath: string): boolean;
  statSync(absPath: string): FsStat | null;
  mkdirSync(absPath: string): void;
  readdirSync(absPath: string): string[];
  unlinkSync(absPath: string): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(absPath: string, opts?: { recursive?: boolean; force?: boolean }): void;
}

let _instanceRoot: string | null = null;
function _getInstanceRoot(): string {
  if (_instanceRoot === null) _instanceRoot = getPathManager().instance().root();
  return _instanceRoot;
}

/**
 * 判断路径是否需要走 docker exec。
 * instance root 下（排除 node_modules/）是 bind-mount 同路径的，宿主机可直接访问。
 */
function _needsProxy(absPath?: string): boolean {
  const sb = getSandboxManager();
  if (!sb?.isEnabled()) return false;
  if (!absPath) return true;
  const root = _getInstanceRoot();
  if (absPath === root || absPath.startsWith(root + "/")) {
    const rel = absPath.slice(root.length + 1);
    if (rel === "node_modules" || rel.startsWith("node_modules/")) return true;
    return false;
  }
  return true;
}

// Container recovery — re-exported from container-recovery.ts for backward compat
export { type RecoveryKind, buildContainerDiagnostic, withContainerRecovery, probeRecoveryKind } from "./container-recovery.js";
import { withContainerRecovery } from "./container-recovery.js";

/** @internal Shared sync write — writeTextSync / writeBinarySync / appendTextSync. */
function _syncWriteToFile(absPath: string, data: string | Buffer, redirect: ">" | ">>", user: string): void {
  if (!_needsProxy(absPath)) {
    nodeMkdirSync(dirname(absPath), { recursive: true });
    if (redirect === ">>") appendFileSync(absPath, data);
    else writeFileSync(absPath, data);
    return;
  }
  runInContainerSync(
    _containerName(),
    `set -eu; dir=$(dirname -- "$1"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; cat ${redirect} "$1"`,
    [absPath],
    { input: data, user },
  );
}

/** @internal Parse `stat -c "%F %s"` output into our stat shape. */
function _parseStatOutput(out: string): FsStat | null {
  if (out === "MISSING" || !out) return null;
  const parts = out.split(" ");
  const size = Number(parts.pop());
  const type = parts.join(" ");
  return { isFile: type === "regular file" || type === "regular empty file", isDirectory: type === "directory", size };
}

/** @internal Create a sandboxFs bound to a specific user. Used by createAgentFs. */
function _createSandboxFs(user: string): SandboxFs {
  return {
    needsProxy: _needsProxy,

    // ── async methods ───────────────────────────────────────────────────

    async readText(absPath: string): Promise<string> {
      if (!_needsProxy(absPath)) return readFile(absPath, "utf-8");
      return withContainerRecovery("readText", () => containerReadText(absPath, user));
    },

    async readBinary(absPath: string, maxBytes?: number): Promise<Buffer> {
      if (!_needsProxy(absPath)) {
        if (maxBytes === undefined) return readFile(absPath);
        const fh = await open(absPath, "r");
        try {
          const buf = Buffer.allocUnsafe(maxBytes);
          const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
          return buf.subarray(0, bytesRead);
        } finally { await fh.close(); }
      }
      return withContainerRecovery("readBinary", () => containerReadBinary(absPath, maxBytes, user));
    },

    async writeText(absPath: string, content: string): Promise<void> {
      if (!_needsProxy(absPath)) {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content);
        return;
      }
      return withContainerRecovery("writeText", () => containerWriteText(absPath, content, user));
    },

    async exists(absPath: string): Promise<boolean> {
      if (!_needsProxy(absPath)) return nodeExistsSync(absPath);
      try {
        return await withContainerRecovery("exists", async () => {
          const r = await runInContainer(_containerName(), 'test -e "$1" && echo y || echo n', [absPath], { allowFailure: true, user });
          return r.stdout.toString("utf-8").trim() === "y";
        });
      } catch (err: any) {
        if (err.containerUnavailable) throw err;
        return false;
      }
    },

    async stat(absPath: string): Promise<FsStat | null> {
      if (!_needsProxy(absPath)) {
        const s = await fsStat(absPath).catch(() => null);
        if (!s) return null;
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size } as FsStat;
      }
      try {
        return await withContainerRecovery("stat", async () => {
          const r = await runInContainer(_containerName(), 'stat -c "%F %s" -- "$1" 2>/dev/null || echo MISSING', [absPath], { user });
          return _parseStatOutput(r.stdout.toString("utf-8").trim());
        });
      } catch (err: any) {
        if (err.containerUnavailable) throw err;
        return null;
      }
    },

    async listDir(absPath: string): Promise<string[]> {
      if (!_needsProxy(absPath)) {
        const entries = await readdir(absPath, { withFileTypes: true });
        return entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => e.isDirectory() ? `[dir]  ${e.name}` : `[file] ${e.name}`);
      }
      return withContainerRecovery("listDir", () => containerListDir(absPath, user));
    },

    async mkdir(absPath: string): Promise<void> {
      if (!_needsProxy(absPath)) { await mkdir(absPath, { recursive: true }); return; }
      await withContainerRecovery("mkdir", () => runInContainer(_containerName(), 'mkdir -p -- "$1"', [absPath], { user }).then(() => {}));
    },

    async glob(baseDir: string, pattern: string): Promise<string[]> {
      if (!_needsProxy(baseDir)) throw new Error("sandboxFs.glob only supports container paths");
      return withContainerRecovery("glob", () => containerGlob(baseDir, pattern, user));
    },

    async grep(
      searchPath: string,
      pattern: string,
      opts?: GrepOptions,
    ): Promise<string> {
      if (!_needsProxy(searchPath)) return hostGrep(searchPath, pattern, opts);
      return withContainerRecovery("grep", () => containerGrep(searchPath, pattern, opts, user));
    },

    // ── sync methods ────────────────────────────────────────────────────

    readTextSync(absPath: string): string {
      if (!_needsProxy(absPath)) return readFileSync(absPath, "utf-8");
      const r = runInContainerSync(_containerName(), 'set -eu; cat -- "$1"', [absPath], { user });
      return r.stdout.toString("utf-8");
    },

    writeTextSync(absPath: string, content: string): void {
      _syncWriteToFile(absPath, content, ">", user);
    },

    appendTextSync(absPath: string, content: string): void {
      _syncWriteToFile(absPath, content, ">>", user);
    },

    existsSync(absPath: string): boolean {
      if (!_needsProxy(absPath)) return nodeExistsSync(absPath);
      const r = runInContainerSync(
        _containerName(),
        'test -e "$1" && echo y || echo n',
        [absPath],
        { allowFailure: true, user },
      );
      return r.stdout.toString("utf-8").trim() === "y";
    },

    statSync(absPath: string): FsStat | null {
      if (!_needsProxy(absPath)) {
        try {
          const s = nodeStatSync(absPath);
          return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size } as FsStat;
        } catch { return null; }
      }
      const r = runInContainerSync(
        _containerName(),
        'stat -c "%F %s" -- "$1" 2>/dev/null || echo MISSING',
        [absPath],
        { allowFailure: true, user },
      );
      return _parseStatOutput(r.stdout.toString("utf-8").trim());
    },

    mkdirSync(absPath: string): void {
      if (!_needsProxy(absPath)) { nodeMkdirSync(absPath, { recursive: true }); return; }
      runInContainerSync(_containerName(), 'mkdir -p -- "$1"', [absPath], { user });
    },

    readdirSync(absPath: string): string[] {
      if (!_needsProxy(absPath)) return nodeReaddirSync(absPath);
      const r = runInContainerSync(
        _containerName(),
        'set -eu; ls -1a -- "$1" | grep -v "^\\.\\.\\?$"',
        [absPath],
        { allowFailure: true, user },
      );
      if (r.code !== 0 || !r.stdout.length) return [];
      return r.stdout.toString("utf-8").trim().split("\n").filter(Boolean);
    },

    unlinkSync(absPath: string): void {
      if (!_needsProxy(absPath)) { nodeUnlinkSync(absPath); return; }
      runInContainerSync(_containerName(), 'rm -f -- "$1"', [absPath], { user });
    },

    writeBinarySync(absPath: string, data: Buffer): void {
      _syncWriteToFile(absPath, data, ">", user);
    },

    renameSync(oldPath: string, newPath: string): void {
      if (!_needsProxy(oldPath) && !_needsProxy(newPath)) {
        nodeRenameSync(oldPath, newPath);
        return;
      }
      runInContainerSync(_containerName(), 'mv -- "$1" "$2"', [oldPath, newPath], { user });
    },

    rmSync(absPath: string, opts?: { recursive?: boolean; force?: boolean }): void {
      if (!_needsProxy(absPath)) {
        nodeRmSync(absPath, { recursive: opts?.recursive ?? false, force: opts?.force ?? false });
        return;
      }
      const flags = (opts?.recursive ? "-rf" : "-f");
      runInContainerSync(_containerName(), `rm ${flags} -- "$1"`, [absPath], { user });
    },
  };
}

/**
 * Module-level sandboxFs for host-side framework code that consumes ContentPart
 * media without an agent context (e.g. `readMediaBytes` in src/llm/media-storage.ts,
 * `sanitizeMedia` in src/context-window/media-normalizer.ts).
 *
 * The container user is resolved once at module load (`HOST_USER` — same
 * default as `createAgentFs`'s non-privileged path) and stays stable for the
 * worker's lifetime. Agent-facing code should keep using `ctx.fs` / `createAgentFs`.
 */
export const sandboxFs: SandboxFs = _createSandboxFs(resolveContainerUser(false));

/** Standalone getter — like getFSWatcher(). Importable by lib/slot/plugin without ctx. */
export function getSandboxFs(): SandboxFs {
  return sandboxFs;
}

// ─── AgentFsAPI — CWD 感知的文件操作接口 ─────────────────────────────────────
//
// 挂载在 AgentContext.fs 上，供工具使用。
// 所有方法接受相对或绝对路径：
//   相对路径 → 基于 CURRENT_DIR 解析（通过 TeamBoard）
//   绝对路径 → 直接传递给 sandboxFs

export interface AgentFsAPI {
  /** Resolve relative path against CURRENT_DIR, return absolute. Absolute paths pass through. */
  resolve(path: string): string;
  /** Whether the resolved path needs container proxy (runtime-aware). */
  needsProxy(path: string): boolean;
  /** Read text file. */
  readText(path: string): Promise<string>;
  /** Read binary file, optionally limited to maxBytes. */
  readBinary(path: string, maxBytes?: number): Promise<Buffer>;
  /** Write text file (auto mkdir -p). */
  writeText(path: string, content: string): Promise<void>;
  /** Check if file/directory exists. */
  exists(path: string): Promise<boolean>;
  /** Get file stat. Returns null if not found. */
  stat(path: string): Promise<FsStat | null>;
  /** List directory contents. Returns "[dir]  name" / "[file] name" format. */
  listDir(path: string): Promise<string[]>;
  /** mkdir -p */
  mkdir(path: string): Promise<void>;
  /** Glob file search inside container. Only valid when needsProxy(path) is true. */
  glob(baseDir: string, pattern: string): Promise<string[]>;
  /** Grep content search — auto-routes host (ripgrep/grep) vs container (docker exec grep). */
  grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string>;

  // sync — same signatures as SandboxFs, delegates with CWD resolution
  readTextSync: SandboxFs["readTextSync"];
  writeTextSync: SandboxFs["writeTextSync"];
  writeBinarySync: SandboxFs["writeBinarySync"];
  appendTextSync: SandboxFs["appendTextSync"];
  existsSync: SandboxFs["existsSync"];
  statSync: SandboxFs["statSync"];
  mkdirSync: SandboxFs["mkdirSync"];
  readdirSync: SandboxFs["readdirSync"];
  unlinkSync: SandboxFs["unlinkSync"];
  renameSync: SandboxFs["renameSync"];
  rmSync: SandboxFs["rmSync"];
}

export function createAgentFs(
  pathManager: PathManagerAPI,
  teamBoard: TeamBoardAPI,
  agentId: string,
): AgentFsAPI {
  const user = resolveContainerUser(false);
  const fs = _createSandboxFs(user);

  const res = (path: string): string => {
    if (isAbsolute(path)) return pathManager.resolve({ path }, agentId);
    const cwd = teamBoard.get(agentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined;
    if (cwd) return resolvePath(cwd, path);
    return pathManager.resolve({ path }, agentId);
  };

  return {
    resolve: res,
    needsProxy(path: string) { return fs.needsProxy(path); },
    readText(path) { return fs.readText(res(path)); },
    readBinary(path, maxBytes?) { return fs.readBinary(res(path), maxBytes); },
    writeText(path, content) { return fs.writeText(res(path), content); },
    exists(path) { return fs.exists(res(path)); },
    stat(path) { return fs.stat(res(path)); },
    listDir(path) { return fs.listDir(res(path)); },
    mkdir(path) { return fs.mkdir(res(path)); },
    glob(baseDir, pattern) { return fs.glob(res(baseDir), pattern); },
    grep(searchPath, pattern, opts) { return fs.grep(res(searchPath), pattern, opts); },

    readTextSync(path) { return fs.readTextSync(res(path)); },
    writeTextSync(path, content) { fs.writeTextSync(res(path), content); },
    appendTextSync(path, content) { fs.appendTextSync(res(path), content); },
    existsSync(path) { return fs.existsSync(res(path)); },
    statSync(path) { return fs.statSync(res(path)); },
    mkdirSync(path) { fs.mkdirSync(res(path)); },
    readdirSync(path) { return fs.readdirSync(res(path)); },
    unlinkSync(path) { fs.unlinkSync(res(path)); },
    writeBinarySync(path, data) { fs.writeBinarySync(res(path), data); },
    renameSync(oldPath, newPath) { fs.renameSync(res(oldPath), res(newPath)); },
    rmSync(path, opts?) { fs.rmSync(res(path), opts); },
  };
}
