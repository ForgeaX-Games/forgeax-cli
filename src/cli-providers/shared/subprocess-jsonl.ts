// Shared adapter: spawn a CLI binary, stream its stdout as ndjson lines,
// and bridge an AbortSignal to SIGTERM (then SIGKILL after a grace period).
//
// Used by ClaudeCodeProvider (Phase 2) and CodexProvider (Phase 2.5). The
// translator (claude-code-mapper.ts / codex-mapper.ts) sits on top of this
// and converts each parsed JSON line into a ChatEvent.

// friendlyPath 已搬到 api/lib/ (commit 64078a4); cli-providers 复活时 reuse 那一份。
import { spawn } from 'node:child_process';
import { friendlyPath } from '@forgeax/platform-io';

export interface SpawnJsonlOptions {
  /** Absolute path or PATH-resolvable binary name. */
  cmd: string;
  /** Argv tail (the binary's flags + positional args). */
  args: string[];
  /** Working directory for the subprocess. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra env vars (merged onto process.env). */
  env?: Record<string, string>;
  /**
   * Optional env override applied AFTER the process.env + env merge. A key
   * whose value is `undefined` is DELETED from the child env (a key with a
   * string value overwrites it). Used by the credential floor (T-C0 phase-1)
   * to scrub non-essential host secrets when running an imported-trust turn.
   * Absent ⇒ today's exact behavior (full process.env inherited).
   */
  envOverride?: Record<string, string | undefined>;
  /**
   * Optional payload written to the subprocess's stdin and then EOF-closed.
   * If omitted, stdin is closed immediately.
   */
  stdin?: string;
  /** Abort signal — triggers SIGTERM + grace-period SIGKILL. */
  signal: AbortSignal;
  /** Grace ms between SIGTERM and SIGKILL. Default 2000. */
  killGraceMs?: number;
}

export interface SpawnJsonlResult<T> {
  /** Async iterator over JSON-parsed stdout lines. */
  lines: AsyncIterable<T>;
  /** Promise resolves with exit code AFTER stdout/stderr are drained. */
  exit: Promise<{ code: number; stderr: string }>;
}

/** Spawn a CLI emitting ndjson on stdout. Each non-empty line is JSON.parse'd
 *  and yielded as T. Malformed lines are skipped silently except for a
 *  console.warn at server stderr (with friendlyPath-redacted cmd), so the
 *  caller's stream consumer never has to handle parse errors itself. */
export function spawnJsonl<T = unknown>(opts: SpawnJsonlOptions): SpawnJsonlResult<T> {
  const { cmd, args, cwd, env, envOverride, stdin, signal, killGraceMs = 2000 } = opts;

  // 子进程 env:process.env ← env ← envOverride。envOverride 里值为 undefined
  // 的 key 被删除(spawn env 不含该 key = 不继承),string 值覆盖。无 envOverride 时
  // 行为与历史完全一致(全量继承 process.env)。
  const childEnv: Record<string, string | undefined> = { ...process.env, ...(env ?? {}) };
  if (envOverride) {
    for (const [k, v] of Object.entries(envOverride)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
  }

  const isWindows = process.platform === 'win32';
  const child = spawn(cmd, args, {
    cwd: cwd ?? process.cwd(),
    env: childEnv,
    stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // ★ 关键(POSIX):detached → 子进程 setsid 成新 session/进程组、**脱离控制终端**。
    //   否则 CLI 内核(codebuddy / claude-code 等)作为 server 的后台进程组子进程,一旦碰
    //   控制终端(查终端尺寸/title 等),内核会发 SIGTTOU/SIGTTIN 给**整个进程组**,把 server
    //   一起冻成 STAT T(stopped)。对齐 agent-host/kernel-process.ts 的 detached 隔离。
    //   Windows:仅 windowsHide 抑制控制台窗口(整组杀经 -pid 抛错回退单进程杀)。
    detached: !isWindows,
    windowsHide: isWindows,
  });
  // stream 解码:setEncoding('utf8') 让异步迭代产出已正确跨块解码的字符串(免手搓 TextDecoder)。
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  // Stdin payload + EOF
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  }

  // detached 后子进程是进程组 leader(pgid==pid):杀**整组**(-pid)一并收掉它 spawn 的孙子
  //   进程,不留孤儿;pid 非法或不允许时回退杀单进程。(-0 会误杀自身组,故严格 pid>0。)
  const killGroup = (sig: 'SIGTERM' | 'SIGKILL'): void => {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        /* 组已消失 / 不允许 → 回退单进程 */
      }
    }
    try {
      child.kill(sig);
    } catch {
      /* already dead */
    }
  };

  // Wire abort → SIGTERM, then SIGKILL after grace period.
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Stderr drained in parallel — we keep the text for the exit summary so
  // the caller can surface it in an error ChatEvent.
  let stderrBuf = '';
  const stderrDone = (async () => {
    if (!child.stderr) return;
    for await (const chunk of child.stderr) {
      stderrBuf += chunk as string;
    }
  })();

  // Stdout line splitter.
  async function* iterate(): AsyncIterable<T> {
    if (!child.stdout) return;
    let buf = '';
    try {
      for await (const chunk of child.stdout) {
        buf += chunk as string;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            yield JSON.parse(line) as T;
          } catch (e) {
            // Redact $HOME in the cmd path so the warn doesn't leak
            // /data/home/<user>/... into logs. Execution path stays raw.
            console.warn(
              `[subprocess-jsonl] dropped malformed line from ${friendlyPath(cmd)}: ${(e as Error).message} :: ${line.slice(0, 120)}`,
            );
          }
        }
      }
      // Flush remainder (in case the process didn't terminate stdout with \n).
      const tail = buf.trim();
      if (tail) {
        try {
          yield JSON.parse(tail) as T;
        } catch {
          /* ignore trailing garbage */
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  const exit = (async () => {
    const code = await new Promise<number>((res) => {
      child.once('close', (c) => res(c ?? 0));
      child.once('error', () => res(-1));
    });
    await stderrDone;
    return { code, stderr: stderrBuf };
  })();

  return { lines: iterate(), exit };
}

/**
 * 凭据地板(T-C0 phase-1,粗粒度):为「imported 信任」的 turn 构造一个
 * env override,把宿主进程里**非必要的应用密钥**置为 undefined(经 spawnJsonl
 * 删除,不被子进程继承)。
 *
 * scrub 模型:
 *  - 已知应用密钥显式置空:ARK_IMAGE_KEY / ARK_VIDEO_KEY / AZURE_GPT_IMAGE_KEY /
 *    LITELLM_PROXY_KEY / GEMINI_API_KEY。
 *  - 泛化:process.env 中所有匹配 /(_KEY|_SECRET|_TOKEN)$/i 的 key 一并置空。
 *  - keep-list:ANTHROPIC_API_KEY / OPENAI_API_KEY 在本函数**不 scrub**(保持兼容);
 *    真正的剥离由内核**叠加** envOverride 完成 —— 见下。
 *
 * 模型 key 剥离(已落地,C0-a):imported turn 由 `claude-code-kernel`/`codex-kernel`
 * 在本 scrub 之上叠加 `ANTHROPIC_API_KEY/OPENAI_API_KEY = <nonce>` + `*_BASE_URL = 环回代理`
 * (见 `kernel/cred-proxy.ts`)——子进程拿到的是一次性 nonce,真 key 留宿主,代理换真 key
 * 转发。故 imported 子进程 env 里**没有真模型 key**。
 * 残留(deferred,需 sidecar 文件系统沙箱):OAuth 登录态(`~/.claude.json` 等)是磁盘
 * 文件,imported 仍能读 —— env 这条路已堵,文件层留待 R3 进程沙箱。
 */
export function scrubbedSecretEnv(): Record<string, string | undefined> {
  const KEEP = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  const KNOWN = [
    'ARK_IMAGE_KEY',
    'ARK_VIDEO_KEY',
    'AZURE_GPT_IMAGE_KEY',
    'LITELLM_PROXY_KEY',
    'GEMINI_API_KEY',
  ];
  const scrub: Record<string, string | undefined> = {};
  for (const k of KNOWN) {
    if (!KEEP.has(k)) scrub[k] = undefined;
  }
  for (const k of Object.keys(process.env)) {
    if (KEEP.has(k)) continue;
    if (/(_KEY|_SECRET|_TOKEN)$/i.test(k)) scrub[k] = undefined;
  }
  return scrub;
}
