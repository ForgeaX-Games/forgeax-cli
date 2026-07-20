/**
 * trust.ts —— workspace 信任门(对齐 cc):存储 + 祖先遍历 + 降级门 + 文案 SSOT。
 *
 * 语义(设计稿 docs/tui-startup-trust-and-banner.md §3.1):
 *   - 布尔信任、无档位;信任一个目录 = 自动信任整棵子树(isTrusted 向上走祖先)。
 *   - 状态存**用户全局** `~/.forgeax/projects.json`(FORGEAX_CONFIG_DIR 可覆盖根),
 *     按项目**绝对 realpath** key;**绝不**存进项目目录 —— 否则恶意仓库可自带
 *     「已信任」配置绕过弹窗。
 *   - 刻意不进 settings.json:settings 是用户意图(项目层进 git、三层 deep-merge),
 *     trust 是机器状态;两文件分离与 cc(settings.json / .claude.json)同构。
 *   - 读永不抛:缺文件/坏 JSON → 未信任(fail closed);写 best-effort(失败下次重弹)。
 *   - 门保护的不是「读文件」,而是「启动即执行」(hooks / MCP / plugins / 项目配置装配);
 *     拒绝 = 调用方直接退出,不装配任何东西。
 *
 * Boundary(HOST 层):仅 core 相对 + node:。
 */
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configHomeDir } from './settings';

// ─── 存储(~/.forgeax/projects.json)─────────────────────────────────────────

export interface TrustEntry {
  trusted: boolean;
  /** ISO 时间戳(接受时刻;幂等覆盖写,机器状态非审计日志)。 */
  acceptedAt?: string;
}

/** 用户全局 projects 状态文件路径(复用 settings 的 configHomeDir 根)。 */
export function projectsFilePath(): string {
  return join(configHomeDir(), 'projects.json');
}

/** realpath 归一(symlink 下同一目录不重复弹);目录不存在等失败 → resolve 兜底。 */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 读 projects map;缺文件/坏 JSON/形状不对 → {}(读永不抛 → fail closed = 未信任)。 */
function readProjects(): Record<string, TrustEntry> {
  try {
    const parsed = JSON.parse(readFileSync(projectsFilePath(), 'utf8')) as {
      projects?: unknown;
    };
    const projects = parsed?.projects;
    return projects && typeof projects === 'object' && !Array.isArray(projects)
      ? (projects as Record<string, TrustEntry>)
      : {};
  } catch {
    return {};
  }
}

/** cwd 或其任一祖先目录 trusted → true(向下继承是内建语义,不是选项;对齐 cc)。 */
export function isTrusted(cwd: string): boolean {
  const projects = readProjects();
  let dir = normalizePath(cwd);
  while (true) {
    if (projects[dir]?.trusted === true) return true;
    const parent = dirname(dir);
    if (parent === dir) return false; // 到根为止
    dir = parent;
  }
}

/** 幂等落盘信任(读→merge→写,`JSON + \n`)。写失败静默(fail-closed 方向:下次重弹)。 */
export function persistTrust(cwd: string): void {
  try {
    const projects = readProjects();
    projects[normalizePath(cwd)] = { trusted: true, acceptedAt: new Date().toISOString() };
    const path = projectsFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ projects }, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

// ─── 文案 SSOT(Ink 弹窗 Trust.tsx 与纯文本降级门共用)───────────────────────

export const TRUST_TITLE = 'Do you trust the files in this folder?';
export const TRUST_BODY =
  'forgeax-core 将可以读取、修改、执行此目录下的文件,并加载其中的 hooks / MCP / 项目配置。仅对来源可信的目录继续。';
export const TRUST_HOME_WARNING =
  '注意:当前在 home 目录 —— 信任它 = 信任其下所有子目录。建议到具体项目目录里启动。';
export const TRUST_OPTIONS = [
  { label: 'Yes, I trust this folder', value: 'trust' },
  { label: 'No, exit', value: 'exit' },
] as const;

/** cwd 是否 home 目录(弹窗/降级门追加 dim 警告行用)。 */
export function isHomeDir(cwd: string): boolean {
  return normalizePath(cwd) === normalizePath(homedir());
}

// ─── 纯文本降级门(readline y/N;--no-tui 交互分支 + Ink 弹窗崩溃降级)────────

export interface TrustPromptIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** 纯文本 y/N 门:默认 N(fail-closed)。io 可注入(测试);缺省 stdin/stdout。 */
export async function textTrustPrompt(cwd: string, io: TrustPromptIo = {}): Promise<boolean> {
  const output = io.output ?? process.stdout;
  output.write(`\n${TRUST_TITLE}\n\n  ${normalizePath(cwd)}\n\n${TRUST_BODY}\n`);
  if (isHomeDir(cwd)) output.write(`${TRUST_HOME_WARNING}\n`);
  const rl = createInterface({ input: io.input ?? process.stdin, output });
  try {
    const answer = await new Promise<string>((res) =>
      rl.question(`\n${TRUST_OPTIONS[0].label}? [y/N] `, res),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ─── 信任门(main.ts runCli 在任何装配之前调;TUI 回落 try/catch 之外)────────

export interface TrustGateOpts {
  cwd: string;
  /** 交互式(prompt==null && 非 serve && stdin TTY)才弹;非交互对齐 cc `-p` 跳过。 */
  interactive: boolean;
  /** TUI 分支 → 先试 Ink 弹窗;弹窗异常降级 textTrustPrompt(绝不因异常放行)。 */
  wantTui: boolean;
  /** Ink 弹窗 thunk(main.ts 传动态 import;只在 wantTui 时被调)。 */
  dialog?: (cwd: string) => Promise<boolean>;
  /** 降级门(注入供测试;缺省 textTrustPrompt)。 */
  prompt?: (cwd: string) => Promise<boolean>;
  /** env(注入供测试;缺省 process.env)。FORGEAX_SKIP_TRUST=1 为 CI/演示逃生口。 */
  env?: Record<string, string | undefined>;
}

/**
 * 信任门:true = 放行(已信任 / 非交互 / 跳过 / 用户接受,接受即落盘);
 * false = 用户拒绝 → 调用方直接退出,**不装配任何项目侧可执行配置**。
 * 同 session 不重复弹:门在 runCli 每进程只过一次,接受即落盘(天然满足,无需内存 flag)。
 */
export async function trustGate(opts: TrustGateOpts): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!opts.interactive || env.FORGEAX_SKIP_TRUST) return true;
  if (isTrusted(opts.cwd)) return true;
  const prompt = opts.prompt ?? ((cwd: string) => textTrustPrompt(cwd));
  let ok: boolean;
  if (opts.wantTui && opts.dialog) {
    try {
      ok = await opts.dialog(opts.cwd);
    } catch {
      // Ink 崩 → 降级纯文本门(Fail Fast + Graceful Degradation §9:降级到手动,不跳过)。
      ok = await prompt(opts.cwd);
    }
  } else {
    ok = await prompt(opts.cwd);
  }
  if (ok) persistTrust(opts.cwd);
  return ok;
}
