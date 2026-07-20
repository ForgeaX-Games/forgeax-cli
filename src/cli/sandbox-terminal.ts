/**
 * OS 级沙箱 TerminalManager 装饰器(E-03)—— core 三形态里唯一的 OS 进程隔离路径。
 *
 * 背景:`SandboxFs` **不是沙箱**(是依赖注入接缝,不约束进程能力),`NodeTerminal`
 * 裸 `spawn` 子进程全权访问文件系统。本模块在 **HOST 层**(src/cli/)给 `TerminalManager`
 * 套一层真正的 OS 沙箱:
 *   - macOS → `sandbox-exec`(Seatbelt/SBPL),系统自带二进制;
 *   - Linux → `bwrap`(bubblewrap),常见系统包;
 *   - 其它平台(Windows)→ 不支持,**loud 降级**(显式告知,绝不静默)。
 *
 * 隔离策略:写入**限定在 cwd + 临时目录**;cwd 外(如 `~/.ssh`、系统路径)写入被
 * **OS 层**拒绝(不是规则层)。cwd 内的 `.git` / `.forgeax` 受保护子路径仍只读
 * (与 `permission/engine.isProtectedPath` 的保护集合同一 SSOT 语义)。读取不设限
 * (工具需要广读上下文)。
 *
 * 设计:**装饰器**——不改 `NodeTerminal`,不改机制层。把 `(cmd,args)` 改写成
 * 「在沙箱里跑原命令」的 argv,再委托给内层 terminal 执行(后台任务/kill/stream
 * 全部复用内层实现)。经 inject seam(`toolContext.terminal`)注入,机制层零改动。
 *
 * Boundary: HOST 层,允许 `node:child_process`/`node:fs`/`node:os`(对齐 io.ts)。
 *   **不引任何第三方依赖**(sandbox-exec/bwrap 都是系统二进制)——机制层 boundary 不破,
 *   两份 allow-list 无需改。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { TerminalManager, RunOpts, RunResult, TaskHandle, Chunk } from '../inject/types';
import { PROTECTED_DIR_SEGMENTS } from '../permission/engine';
import { getMergedSettings } from './settings';

export type SandboxKind = 'seatbelt' | 'bwrap' | 'none';

/** 沙箱当前状态(doctor / 降级日志 / 测试断言共用)。 */
export interface SandboxStatus {
  /** 用户是否要求开启(flag/env/settings)。 */
  requested: boolean;
  /** 实际是否生效(requested && available)。 */
  enabled: boolean;
  /** 平台是否支持 + 沙箱二进制在 PATH。 */
  available: boolean;
  /** 平台对应的沙箱种类。 */
  kind: SandboxKind;
  /** 人读说明(为何 enabled / 为何降级)。 */
  reason: string;
}

/** 平台 → 沙箱种类。 */
export function detectSandboxKind(platform: NodeJS.Platform = process.platform): SandboxKind {
  if (platform === 'darwin') return 'seatbelt';
  if (platform === 'linux') return 'bwrap';
  return 'none';
}

/** 沙箱二进制是否可用(seatbelt=/usr/bin/sandbox-exec;bwrap=PATH 查找)。 */
export function sandboxBinaryPresent(kind: SandboxKind): boolean {
  if (kind === 'seatbelt') return existsSync('/usr/bin/sandbox-exec');
  if (kind === 'bwrap') {
    const r = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
    return r.status === 0 && (r.stdout ?? '').trim().length > 0;
  }
  return false;
}

/** env 真值判定(1/true/on/yes)。 */
function envTruthy(v: string | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return undefined;
}

/**
 * 解析「是否要求开启沙箱」:显式 flag(--sandbox/--no-sandbox)> env `FORGEAX_SANDBOX`
 * > settings `sandbox.enabled` > 默认关(保守:零回归,可用时 doctor 会建议开启)。
 */
export function sandboxRequested(
  explicit?: boolean,
  cwd: string = process.cwd(),
): boolean {
  if (explicit !== undefined) return explicit;
  const env = envTruthy(process.env.FORGEAX_SANDBOX);
  if (env !== undefined) return env;
  const s = getMergedSettings(cwd) as { sandbox?: { enabled?: unknown } };
  if (typeof s.sandbox?.enabled === 'boolean') return s.sandbox.enabled;
  return false;
}

/** 解析当前沙箱状态(requested + 平台可用性)。 */
export function resolveSandboxStatus(
  requested: boolean,
  platform: NodeJS.Platform = process.platform,
): SandboxStatus {
  const kind = detectSandboxKind(platform);
  const available = kind !== 'none' && sandboxBinaryPresent(kind);
  const enabled = requested && available;
  let reason: string;
  if (!requested) reason = available ? `sandbox available (${kind}) — enable with --sandbox` : `sandbox not requested`;
  else if (enabled) reason = `sandbox active (${kind}), writes confined to cwd + temp`;
  else if (kind === 'none') reason = `sandbox unsupported on ${platform} — running WITHOUT OS isolation`;
  else reason = `sandbox binary for ${kind} not found — running WITHOUT OS isolation`;
  return { requested, enabled, available, kind, reason };
}

// ─── 沙箱 argv 构造 ──────────────────────────────────────────────────────────

/** SBPL 字符串字面量转义(路径进 `"..."`)。 */
function sbplQuote(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** cwd 的 realpath(mac 下 /tmp→/private/tmp 等符号链接);解析失败回退原值。 */
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** macOS Seatbelt SBPL:allow default,deny 所有写,再放行 cwd + 临时目录 + /dev,
 *  最后收回 cwd 内受保护子路径(.git/.forgeax)。规则后写覆盖先写。 */
export function buildSeatbeltProfile(cwd: string): string {
  const root = realpath(cwd);
  const writable = [
    root,
    realpath(tmpdir()),
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
    '/dev',
  ];
  const allowWrite = writable.map((p) => `  (subpath ${sbplQuote(p)})`).join('\n');
  // cwd 内受保护目录段收回只读(SSOT 复用 permission/engine 的 PROTECTED_DIR_SEGMENTS)。
  const protectedPaths = PROTECTED_DIR_SEGMENTS.map((seg) => `${root}/${seg}`);
  const denyProtected = protectedPaths.map((p) => `  (subpath ${sbplQuote(p)})`).join('\n');
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    allowWrite,
    ')',
    '(deny file-write*',
    denyProtected,
    ')',
  ].join('\n');
}

/** 把 (cmd,args) 包成 macOS sandbox-exec 调用。 */
export function wrapSeatbelt(cmd: string, args: string[], cwd: string): [string, string[]] {
  return ['sandbox-exec', ['-p', buildSeatbeltProfile(cwd), cmd, ...args]];
}

/** 把 (cmd,args) 包成 Linux bwrap 调用:整机只读绑定,cwd 读写,cwd 内 .git/.forgeax 收回只读。 */
export function wrapBwrap(cmd: string, args: string[], cwd: string): [string, string[]] {
  const root = realpath(cwd);
  // cwd 内受保护目录段收回只读(SSOT 复用 PROTECTED_DIR_SEGMENTS)。
  const protectedRo = PROTECTED_DIR_SEGMENTS.flatMap((seg) => [
    '--ro-bind-try', `${root}/${seg}`, `${root}/${seg}`,
  ]);
  const bwrapArgs = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', root, root,
    ...protectedRo,
    '--bind-try', '/tmp', '/tmp',
    '--chdir', root,
    '--',
    cmd,
    ...args,
  ];
  return ['bwrap', bwrapArgs];
}

/** 按 kind 把 (cmd,args) 改写成沙箱调用(none → 原样)。 */
function wrapForSandbox(kind: SandboxKind, cmd: string, args: string[], cwd: string): [string, string[]] {
  if (kind === 'seatbelt') return wrapSeatbelt(cmd, args, cwd);
  if (kind === 'bwrap') return wrapBwrap(cmd, args, cwd);
  return [cmd, args];
}

// ─── 装饰器 ──────────────────────────────────────────────────────────────────

/**
 * 在内层 `TerminalManager` 外套 OS 沙箱:run/stream/runBackground 把 (cmd,args) 改写
 * 成沙箱调用再委托内层;list/kill/killAll 直接委托(进程管理复用内层)。
 */
export class SandboxedTerminal implements TerminalManager {
  constructor(
    private readonly inner: TerminalManager,
    private readonly kind: SandboxKind,
    private readonly cwd: string,
  ) {}

  private wrap(cmd: string, args: string[], opts?: RunOpts): [string, string[]] {
    return wrapForSandbox(this.kind, cmd, args, opts?.cwd ?? this.cwd);
  }

  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult> {
    const [c, a] = this.wrap(cmd, args, opts);
    return this.inner.run(c, a, opts);
  }
  stream(cmd: string, args: string[], opts?: RunOpts): AsyncIterable<Chunk> {
    const [c, a] = this.wrap(cmd, args, opts);
    return this.inner.stream(c, a, opts);
  }
  runBackground(cmd: string, args: string[], opts?: RunOpts): Promise<TaskHandle> {
    const [c, a] = this.wrap(cmd, args, opts);
    return this.inner.runBackground(c, a, opts);
  }
  list(agentId: string): TaskHandle[] {
    return this.inner.list(agentId);
  }
  kill(taskId: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    return this.inner.kill(taskId, signal);
  }
  killAll(agentId: string): Promise<void> {
    return this.inner.killAll(agentId);
  }
}

/**
 * host 便捷:给定内层 terminal + 「是否要求沙箱」,返回 { terminal, status }。
 * 要求开启但不可用 → **loud 降级**(stderr 警告),返回内层 terminal(不阻断,§9 graceful)。
 */
export function withSandbox(
  inner: TerminalManager,
  explicitSandbox: boolean | undefined,
  cwd: string = process.cwd(),
): { terminal: TerminalManager; status: SandboxStatus } {
  const status = resolveSandboxStatus(sandboxRequested(explicitSandbox, cwd));
  if (status.requested && !status.available) {
    process.stderr.write(`[forgeax-core] ⚠ sandbox requested but unavailable: ${status.reason}\n`);
  }
  const terminal = status.enabled ? new SandboxedTerminal(inner, status.kind, cwd) : inner;
  return { terminal, status };
}
