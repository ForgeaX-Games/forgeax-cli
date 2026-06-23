/** Host-only file system bridge for workspace tools.
 *
 *  当前实现 = 宿主机直读：所有 path 直接走 node:fs / node:child_process。
 *  `needsProxy()` 永远返回 false —— 这是 sandbox 接入前的占位语义。
 *
 *  TODO（sandbox 阶段）：
 *  - forgeax 的 sandbox 会按 SessionConfig.defaultDir 指向的 game-project
 *    在 `~/.forgeax/games/<slug>/` 建立独立容器，把该目录 bind-mount 进容器；
 *    其余路径（包括 ~/.forgeax 用户目录、builtin、其它 game project）走
 *    docker exec。`needsProxy(absPath)` 真正决策时会读 SandboxManager 状态：
 *      sandbox on + 路径在 sandbox 根下（且非 node_modules/）→ 直接 host fs
 *      sandbox on + 其它路径 → docker exec
 *      sandbox off                                              → 全部 host fs
 *  - GrepOptions / glob 容器化版本（containerGlob / containerGrep）补回。
 *  - readBinary 的 maxBytes 容器版用 head -c N | base64。
 *
 *  现在先做最薄的宿主机闭环——把 workspace 工具集跑起来，sandbox 部分单独 PR。 */

import { execFile } from "node:child_process";
import { isAbsolute, dirname, resolve as resolvePath, normalize } from "node:path";
import { mkdir, open, readFile, readdir, stat as fsStat, writeFile } from "node:fs/promises";
import {
  appendFileSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync,
  readdirSync as nodeReaddirSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync,
} from "node:fs";
import { BLACKBOARD_KEYS } from "../defaults/blackboard-vars";
import type { BlackboardAPI } from "../core/types";
import type { PathManagerAPI } from "./types";

const GREP_TIMEOUT_MS = 15_000;
const GREP_SKIP_DIRS = ["node_modules", ".git", "dist", "__pycache__", ".cache"];

export type FsStat = { isFile: boolean; isDirectory: boolean; size: number };

export interface GrepOptions {
  caseInsensitive?: boolean;
  contextLines?: number;
  outputMode?: "content" | "files_with_matches" | "count";
  glob?: string;
  multiline?: boolean;
}

// ─── HostFs primitives ───────────────────────────────────────────────────────

/** Minimum file system primitives — all paths must be absolute.
 *  Sandbox 接入后会换成 routed 版本，签名保持一致。 */
export interface HostFs {
  needsProxy(absPath?: string): boolean;

  readText(absPath: string): Promise<string>;
  readBinary(absPath: string, maxBytes?: number): Promise<Buffer>;
  writeText(absPath: string, content: string): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  stat(absPath: string): Promise<FsStat | null>;
  listDir(absPath: string): Promise<string[]>;
  mkdir(absPath: string): Promise<void>;
  glob(baseDir: string, pattern: string): Promise<string[]>;
  grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string>;

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

// ─── glob (simple recursive walker, fast-glob 替代) ──────────────────────────

function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.+/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === ".") {
      re += "\\.";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
      } else {
        const inner = pattern.slice(i + 1, end);
        const parts = inner.split(",").map((p) => p.split("").map((ch) =>
          /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch,
        ).join(""));
        re += `(?:${parts.join("|")})`;
        i = end + 1;
      }
    } else {
      re += /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

async function walkFiles(
  baseDir: string,
  out: { path: string; mtimeMs: number }[],
  signal: AbortSignal | undefined,
  ignore: (rel: string) => boolean,
  rel = "",
): Promise<void> {
  if (signal?.aborted) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (ignore(childRel)) continue;
    const full = `${baseDir}/${e.name}`;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await walkFiles(full, out, signal, ignore, childRel);
    } else if (e.isFile()) {
      try {
        const st = await fsStat(full);
        out.push({ path: childRel, mtimeMs: st.mtimeMs });
      } catch {
        // ignore unreadable
      }
    }
  }
}

const DEFAULT_GLOB_IGNORES = [
  "node_modules", ".git", "dist", "__pycache__", ".cache",
];

function defaultIgnore(rel: string, dot: boolean): boolean {
  const parts = rel.split("/");
  for (const p of parts) {
    if (DEFAULT_GLOB_IGNORES.includes(p)) return true;
    if (!dot && p.startsWith(".") && p !== "." && p !== "..") return true;
  }
  return false;
}

async function hostGlob(baseDir: string, pattern: string): Promise<string[]> {
  const re = globToRegExp(pattern);
  const dot = pattern.includes("/.") || /(?:^|\/)\./.test(pattern);
  const collected: { path: string; mtimeMs: number }[] = [];
  await walkFiles(baseDir, collected, undefined, (rel) => defaultIgnore(rel, dot));
  return collected
    .filter((r) => re.test(r.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((r) => r.path);
}

// ─── grep (rg → grep -E fallback) ────────────────────────────────────────────

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

// ─── HostFs instance ─────────────────────────────────────────────────────────

function createHostFs(): HostFs {
  return {
    needsProxy(_absPath?: string): boolean { return false; },

    async readText(absPath: string): Promise<string> {
      return readFile(absPath, "utf-8");
    },

    async readBinary(absPath: string, maxBytes?: number): Promise<Buffer> {
      if (maxBytes === undefined) return readFile(absPath);
      const fh = await open(absPath, "r");
      try {
        const buf = Buffer.allocUnsafe(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },

    async writeText(absPath: string, content: string): Promise<void> {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content);
    },

    async exists(absPath: string): Promise<boolean> {
      return nodeExistsSync(absPath);
    },

    async stat(absPath: string): Promise<FsStat | null> {
      const s = await fsStat(absPath).catch(() => null);
      if (!s) return null;
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    },

    async listDir(absPath: string): Promise<string[]> {
      const entries = await readdir(absPath, { withFileTypes: true });
      return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => e.isDirectory() ? `[dir]  ${e.name}` : `[file] ${e.name}`);
    },

    async mkdir(absPath: string): Promise<void> {
      await mkdir(absPath, { recursive: true });
    },

    async glob(baseDir: string, pattern: string): Promise<string[]> {
      return hostGlob(baseDir, pattern);
    },

    async grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string> {
      return hostGrep(searchPath, pattern, opts);
    },

    readTextSync(absPath: string): string {
      return readFileSync(absPath, "utf-8");
    },

    writeTextSync(absPath: string, content: string): void {
      nodeMkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content);
    },

    writeBinarySync(absPath: string, data: Buffer): void {
      nodeMkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, data);
    },

    appendTextSync(absPath: string, content: string): void {
      nodeMkdirSync(dirname(absPath), { recursive: true });
      appendFileSync(absPath, content);
    },

    existsSync(absPath: string): boolean {
      return nodeExistsSync(absPath);
    },

    statSync(absPath: string): FsStat | null {
      try {
        const s = nodeStatSync(absPath);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
      } catch { return null; }
    },

    mkdirSync(absPath: string): void {
      nodeMkdirSync(absPath, { recursive: true });
    },

    readdirSync(absPath: string): string[] {
      return nodeReaddirSync(absPath);
    },

    unlinkSync(absPath: string): void {
      nodeUnlinkSync(absPath);
    },

    renameSync(oldPath: string, newPath: string): void {
      nodeRenameSync(oldPath, newPath);
    },

    rmSync(absPath: string, opts?: { recursive?: boolean; force?: boolean }): void {
      nodeRmSync(absPath, { recursive: opts?.recursive ?? false, force: opts?.force ?? false });
    },
  };
}

let _hostFs: HostFs | null = null;
export function getHostFs(): HostFs {
  if (_hostFs === null) _hostFs = createHostFs();
  return _hostFs;
}

/** Re-exported for test reset. */
export function resetHostFs(): void { _hostFs = null; }

// ─── AgentFsAPI ──────────────────────────────────────────────────────────────

export interface AgentFsAPI {
  resolve(path: string): string;
  needsProxy(path: string): boolean;
  readText(path: string): Promise<string>;
  readBinary(path: string, maxBytes?: number): Promise<Buffer>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat | null>;
  listDir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  glob(baseDir: string, pattern: string): Promise<string[]>;
  grep(searchPath: string, pattern: string, opts?: GrepOptions): Promise<string>;

  readTextSync: HostFs["readTextSync"];
  writeTextSync: HostFs["writeTextSync"];
  writeBinarySync: HostFs["writeBinarySync"];
  appendTextSync: HostFs["appendTextSync"];
  existsSync: HostFs["existsSync"];
  statSync: HostFs["statSync"];
  mkdirSync: HostFs["mkdirSync"];
  readdirSync: HostFs["readdirSync"];
  unlinkSync: HostFs["unlinkSync"];
  renameSync: HostFs["renameSync"];
  rmSync: HostFs["rmSync"];
}

/** Build an AgentFsAPI bound to a specific agent's CWD.
 *
 *  CWD resolution order:
 *    1. Absolute input → use directly
 *    2. Relative input → resolve against blackboard.CURRENT_DIR
 *    2.5. CURRENT_DIR also absent → sessionCwd (absolute game root resolved
 *         from session.config.defaultDir slug, bug-20260522) → use directly
 *    3. All absent → agentJson.defaultDir (absolute or relative to agentDir)
 *    4. All absent → agentDir itself */
export function createAgentFs(
  pathManager: PathManagerAPI,
  blackboard: BlackboardAPI,
  agentPath: string,
  agentDir: string,
  defaultDirFallback?: () => string | undefined,
): AgentFsAPI {
  const fs = getHostFs();

  // Project root = the dir that contains `.forgeax/` (games live at
  // <projectRoot>/.forgeax/games/<slug>; gamesDir() == projectRoot/.forgeax/games).
  const projectRoot = resolvePath(pathManager.user().gamesDir(), "..", "..");

  const resolveCwd = (): string => {
    const cwd = blackboard.get(agentPath, BLACKBOARD_KEYS.CURRENT_DIR) as string | undefined;
    if (cwd) return cwd;
    /** bug-20260522: sessionCwd inserted at head of fallback chain. */
    const fb = defaultDirFallback?.();
    if (fb) return isAbsolute(fb) ? fb : resolvePath(agentDir, fb);
    return agentDir;
  };

  const res = (p: string): string => {
    if (isAbsolute(p)) return normalize(p);
    const norm = normalize(p);
    // Paths beginning with the project-root marker dir `.forgeax/` are ALWAYS
    // anchored to the project root, never the cwd. Without this, when the
    // agent's cwd is already inside the game dir (sessionCwd =
    // <root>/.forgeax/games/<slug>) the charter-style path
    // `.forgeax/games/<slug>/main.ts` doubles to
    // .../<slug>/.forgeax/games/<slug>/main.ts (file-not-found), and a stray
    // shell `cd` into node_modules silently misplaces writes there. `.forgeax`
    // is a project-root marker, so any path under it is project-root-relative.
    if (norm === ".forgeax" || norm.startsWith(`.forgeax/`)) {
      return normalize(resolvePath(projectRoot, norm));
    }
    return normalize(resolvePath(resolveCwd(), p));
  };

  return {
    resolve: res,
    needsProxy(path: string) { return fs.needsProxy(res(path)); },
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
    writeBinarySync(path, data) { fs.writeBinarySync(res(path), data); },
    appendTextSync(path, content) { fs.appendTextSync(res(path), content); },
    existsSync(path) { return fs.existsSync(res(path)); },
    statSync(path) { return fs.statSync(res(path)); },
    mkdirSync(path) { fs.mkdirSync(res(path)); },
    readdirSync(path) { return fs.readdirSync(res(path)); },
    unlinkSync(path) { fs.unlinkSync(res(path)); },
    renameSync(oldPath, newPath) { fs.renameSync(res(oldPath), res(newPath)); },
    rmSync(path, opts?) { fs.rmSync(res(path), opts); },
  };
}
