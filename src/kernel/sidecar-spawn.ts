/**
 * sidecarSpawnJsonl —— `spawnJsonl` 的 sidecar 版:让内核经 ring-0 sidecar spawn 进程组,
 * stdout/stderr 经控制 socket(data 通知)流回,**产出与 `spawnJsonl` 同款 `{lines, exit}`**,
 * 故内核侧是 drop-in 切换(S1b)。
 *
 * push→pull 适配:sidecar 的 data/exit 是推送通知;这里缓冲成队列供 async generator 拉取。
 * stdout 累积按 `\n` 切 ndjson + JSON.parse(坏行跳过,同 spawnJsonl);stderr 累积进 exit。
 * signal.abort → client.cancel(callId)(整组杀)。
 */
import type { SidecarClient, StartSessionReq } from './sidecar-client';

/** 物化子进程 env:`{...process.env}` 应用 envOverride(`undefined` 值删除)→ 具体 map。
 *  sidecar 子进程用确切 env(不继承 sidecar 自身 env),故须含 CLI 必需系统变量 + 凭据 override。 */
export function materializeEnv(envOverride?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  if (envOverride) {
    for (const [k, v] of Object.entries(envOverride)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return out;
}

/** 剔除真模型 key —— sidecar 路径不把真 key 外发(由 sidecar cred-vault 注入 scoped)。 */
export function stripModelKeys(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.OPENAI_API_KEY;
  return out;
}

export interface SidecarSpawnResult<T> {
  lines: AsyncIterable<T>;
  exit: Promise<{ code: number; stderr: string }>;
}

export function sidecarSpawnJsonl<T = unknown>(
  client: SidecarClient,
  spec: StartSessionReq,
  signal?: AbortSignal,
): SidecarSpawnResult<T> {
  const sessionId = spec.sessionId;
  const callId = spec.callId ?? sessionId;

  let stdoutBuf = '';
  let stderrAcc = '';
  const queue: T[] = [];
  let finished = false;
  let resolveExit!: (v: { code: number; stderr: string }) => void;
  const exit = new Promise<{ code: number; stderr: string }>((r) => { resolveExit = r; });
  let wake: (() => void) | null = null;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };

  const offData = client.onData(({ sessionId: sid, stream, chunk }) => {
    if (sid !== sessionId) return;
    if (stream === 'stderr') { stderrAcc += chunk; return; }
    stdoutBuf += chunk;
    let i: number;
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, i);
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line.trim()) continue;
      try { queue.push(JSON.parse(line) as T); } catch { /* skip malformed,同 spawnJsonl */ }
    }
    poke();
  });

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    offData();
    offExit();
    resolveExit({ code, stderr: stderrAcc });
    poke();
  };
  const offExit = client.onExit((info) => {
    if (info.sessionId !== sessionId) return;
    finish(info.code ?? -1);
  });

  // 先注册监听再 startSession(避免漏事件)。
  const started = client.startSession(spec).catch((e) => {
    stderrAcc += `startSession failed: ${(e as Error).message}`;
    finish(-1);
  });

  if (signal) {
    const onAbort = () => { client.cancel(callId).catch(() => {}); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const lines = (async function* (): AsyncGenerator<T> {
    await started;
    for (;;) {
      while (queue.length) yield queue.shift() as T;
      if (finished) { while (queue.length) yield queue.shift() as T; return; }
      await new Promise<void>((r) => { wake = r; });
    }
  })() as AsyncIterable<T>;

  return { lines, exit };
}
