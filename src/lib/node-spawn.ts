/**
 * node-spawn —— 子进程 + which 封装,统一走 node:child_process / node:fs
 * (Node 与 Bun 双运行时;Bun 实现 node: 接口)。取代散落的 Bun.spawn / Bun.which,
 * 使 cli 依赖闭包成为 Node-runnable(os2 接入:cli 以标准 Node ESM 形态被 studio
 * 进程内 import,无需 Bun 运行时)。
 *
 *  - runCapture:跑命令到结束,收 stdout(+可选 stderr)+ exit code,不抛(失败→code:null)。
 *    用于版本探测 / zip·unzip 等"跑完看结果"的点。
 *  - which:跨平台 PATH 查找,复刻 Bun.which —— Windows 上遵循 PATHEXT,返回真正的
 *    launcher(claude.cmd / claude.exe),而非 git-bash `which` 返回的、child_process
 *    exec 不了的 shim 路径(这正是旧 `which <name>` 子进程在 Windows 的坑)。
 *  - resolveRuntimeLaunch:解析"用什么运行时拉起一个 .ts/.js 入口"——Bun 用**绝对路径**
 *    (process.execPath,非裸名 'bun':Windows 上裸名经 child_process spawn 会 ENOENT)
 *    跑 .ts;Node 下 .ts 经 TS loader、.js 直跑。用于 spawn agent-host / core --serve。
 *
 *  Boundary: 仅 node: 全局。
 */
import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { join, delimiter, extname } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export interface RunCaptureOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 超时毫秒;到点 kill 子进程(默认无超时)。 */
  timeoutMs?: number;
  /** 是否捕获 stderr(默认 false → 丢弃,等价旧 `stderr:'ignore'`)。 */
  captureStderr?: boolean;
}

export interface RunCaptureResult {
  /** exit code;spawn 失败 / 被 kill → null。 */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Windows 上 .cmd/.bat launcher 无法被 CreateProcess 直接 exec,node:child_process
 * 需 shell:true 经 cmd.exe 路由;POSIX 一律 false(直 exec)。
 */
function needsShell(cmd: string): boolean {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(cmd);
}

/**
 * 跑命令到结束,收 stdout(+可选 stderr)。**永不抛**(spawn 失败 → code:null);
 * 调用方据 code 自行判定。node:child_process —— Node 与 Bun 同款语义。
 */
export function runCapture(cmd: string, args: string[], opts: RunCaptureOpts = {}): Promise<RunCaptureResult> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', opts.captureStderr ? 'pipe' : 'ignore'],
        shell: needsShell(cmd),
        windowsHide: true,
      });
    } catch {
      resolveP({ code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, opts.timeoutMs);
    }
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('error', () => { if (timer) clearTimeout(timer); resolveP({ code: null, stdout, stderr }); });
    child.once('close', (code) => { if (timer) clearTimeout(timer); resolveP({ code, stdout, stderr }); });
  });
}

/** Windows PATHEXT 扩展名列表(含默认兜底);顺序即匹配优先级。 */
function windowsExts(): string[] {
  const pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return pathext.split(';').map((e) => e.trim()).filter(Boolean);
}

/** 存在且可执行:POSIX 查 X_OK;Windows 上"存在 + 命中 PATHEXT"即算(CreateProcess 契约)。 */
function isExecutable(p: string): boolean {
  if (!existsSync(p)) return false;
  if (IS_WINDOWS) return true;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跨平台可执行文件查找,与 Bun.which 对齐。逐个扫 PATH 目录;Windows 上对每个
 * PATHEXT 扩展名各试一次(故 `claude` 解析到 `claude.cmd`/`claude.exe` 这个真正
 * launcher,而非 git-bash `which` 返回的 shim)。命中返回首个绝对路径,否则 null。
 */
export function which(name: string): string | null {
  // 已是路径(含分隔符)→ 直接校验。
  if (name.includes('/') || (IS_WINDOWS && name.includes('\\'))) {
    return isExecutable(name) ? name : null;
  }
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const nameHasExt = IS_WINDOWS && extname(name) !== '';
  for (const dir of dirs) {
    if (!IS_WINDOWS) {
      const cand = join(dir, name);
      if (isExecutable(cand)) return cand;
      continue;
    }
    // Windows:带扩展名的名字逐字匹配;否则对每个 PATHEXT 试。
    if (nameHasExt) {
      const cand = join(dir, name);
      if (isExecutable(cand)) return cand;
      continue;
    }
    for (const ext of windowsExts()) {
      const cand = join(dir, name + ext);
      if (isExecutable(cand)) return cand;
    }
  }
  return null;
}

/** 当前是否在 Bun 运行时(用 globalThis.Bun 探测,Node 下为 undefined)。 */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * 解析"用什么命令拉起一个脚本入口"。
 *  - Bun:`<process.execPath> <entry>`(Bun 下 execPath 即 bun 绝对路径;原生跑 .ts,
 *    用绝对路径规避 Windows 裸名 spawn ENOENT);
 *  - Node + .ts/.tsx:`<node> --import <loader> <entry>`(默认 tsx;
 *    FORGEAX_NODE_TS_LOADER 可指定容器内其它 ESM loader,如 @swc-node/register/esm-register);
 *  - Node + .js/.mjs:`<node> <entry>`。
 */
export function resolveRuntimeLaunch(entry: string, extraArgs: string[] = []): { cmd: string; args: string[] } {
  if (isBunRuntime()) {
    return { cmd: process.execPath || 'bun', args: [entry, ...extraArgs] };
  }
  if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
    const loader = process.env.FORGEAX_NODE_TS_LOADER || 'tsx';
    return { cmd: process.execPath, args: ['--import', loader, entry, ...extraArgs] };
  }
  return { cmd: process.execPath, args: [entry, ...extraArgs] };
}
