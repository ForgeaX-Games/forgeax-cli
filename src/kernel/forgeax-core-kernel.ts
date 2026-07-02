/**
 * forgeax-core 内核装配(产品壳侧)—— **连接式** AgentKernel(R3 内核归一)。
 *
 * 改动前(in-process):server 进程内 `new ForgeaxCoreKernel` + `new CoreAgent`,绕过 sidecar,
 * cred-vault/sandbox/进程监督对它空转。**已移除**(不留 in-process 逃生)。
 *
 * 改动后(本文件):forgeax-core 与 claude-code/codex **同级**——经 sidecar(agent-host)spawn
 * 成 `forgeax-core --serve` 子进程(detached 进程组 + cred-vault scoped token + sandbox),adapter
 * 直连子进程的 per-session unix-sock(双向 JSON-RPC),驱动一轮:
 *   - 出:`runTurn(wireReq)` → KernelEvent 经 `event` 通知流回。
 *   - 入(反向):`hostTool({name,args,sid})` → **复跑 `checkKernelTool`** 后在宿主执行
 *     (信任边界钉在 host;serve 不持危险工具本地实现——评审稿 §3.1)。复用既有 in-process
 *     host-tool 桥 `makeInProcessExecuteTool`(求权威 trustTier → checkKernelTool → executeTool)。
 *
 * 生命周期:**per-session 复用 serve 进程 + 连接**(冷启动优化,2026-06-20)。serve 本就支持
 * 「一连接多轮」(`startServe` 起常驻 RPC server、kernel 按连接建、runTurn 可多次调用),故 adapter
 * 不再每轮 spawn→reap,而是按 session(`hostSessionId||threadId||agentId||'forge'`)缓存 serve
 * 进程,跨轮复用;**只首轮付一次冷启**,后续轮直接复用同一进程/连接。
 *   - idle 回收:一个 session 无在飞轮且静默超过 `FORGEAX_CORE_SERVE_IDLE_MS`(默认 5min)→
 *     `shutdownSession` 回收(对位评审稿 §231 的 idle 回收策略)。
 *   - 软取消:cancel/interrupt 走 serve 的 RPC 控制面(serve 端 abort 在飞 turn),**不杀进程**
 *     (进程留给后续轮复用);硬回收只在 idle/崩溃时发生。
 *   - 崩溃自愈:serve 崩 → `sidecar.onExit` + request 掉线 reject → 驱逐死 session,下一轮
 *     `runTurn` 自动重新 spawn(评审稿 §221 的「自动重起」语义,落到 session 粒度)。
 *   - bg peer 语义不变:facade 仍**每轮**建 scheduler(轮间语义),复用的只是「进程+连接」,
 *     不引入评审稿 §172 的「peer 跨轮存活」行为变化——这是有意的最小改动取舍。
 *   - 逃生闸:`FORGEAX_CORE_SERVE_REUSE=off` → 回退旧 per-turn spawn→run→reap 路径。
 * 崩溃隔离:serve 崩不影响 server,sidecar reap 并回 ExitInfo。
 *
 * 依赖方向:server → (forgeax-cli + agent-host + agent-runtime 契约);**不再** import forgeax-core
 * 内核实现(它在 serve 子进程里),也不再 import agent-host/orchestration。
 */
import {
  type AgentKernel,
  type KernelCapabilities,
  type KernelEvent,
  type KernelHealth,
  type TurnHandle,
  type TurnRequest,
  type ForkExtractRequest,
  type ForkExtractResult,
  getKernel,
  registerKernel,
} from '@forgeax/agent-runtime';

// os2 接入:re-export getKernel,让外部宿主(studio remoteAgentRuntime)从本模块一处
// 同时拿 registerForgeaxCoreKernel + getKernel(不必再单独解析 @forgeax/agent-runtime)。
export { getKernel };
import { connect, type RpcConnection } from '@forgeax/agent-host';
import { ensureSidecar } from './sidecar-singleton';
import { makeInProcessExecuteTool, type HostExecuteToolFn } from './host-tool-bridge';
import { materializeEnv, stripModelKeys } from './sidecar-spawn';
import { resolveRuntimeLaunch } from '../lib/node-spawn';
import { tt, ttEnabled } from '../lib/turn-trace';
import { getConsoleRouterSnapshot } from '../core/logger';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TelemetryRecord } from '@forgeax/types';
import { createTelemetryFileSink, type TelemetryFileSink } from './telemetry-file-sink';

/** forgeax-core serve 入口:经**包解析**定位(`@forgeax/forgeax-core/cli` 导出 + server 包依赖,
 *  发布后跨包仍成立),monorepo 源码态回退相对路径(发包前过渡)。耦合从「硬编码兄弟路径」
 *  收敛到包依赖,与 sidecar(agent-host)同款。 */
function resolveCoreServeEntry(): string {
  try {
    return fileURLToPath(import.meta.resolve('@forgeax/forgeax-core/cli'));
  } catch {
    return resolve(import.meta.dirname, '../../../core/src/cli/main.ts');
  }
}
const CORE_SERVE_ENTRY = resolveCoreServeEntry();

/** core --serve 的运行时启动命令:Node 下 `node --import tsx core.ts`,Bun 下 `bun core.ts`
 *  (双运行时;使外部宿主 studio 无需 bun 即可拉起 core 子进程)。 */
function coreLaunch(endpoint: string): { cmd: string; args: string[] } {
  return resolveRuntimeLaunch(CORE_SERVE_ENTRY, ['--serve', '--sock', endpoint]);
}

// forkExtract:经复用 serve 会话发 forkExtract RPC,sidecar 内 facade 跑 cache-safe fork(已实现)。
const CAPS: KernelCapabilities = { streaming: true, thinking: true, toolCalls: true, midTurnInject: false, forkExtract: true };

/** idle 回收阈值:session 无在飞轮且静默超过此毫秒数 → reap serve 进程。默认 5min。
 *  use-time 读 env(便于运行期/测试调阈值);<=0 = 永不 idle 回收。 */
function serveIdleMs(): number {
  return Number(process.env.FORGEAX_CORE_SERVE_IDLE_MS ?? 300_000);
}
/** per-session 复用开关。`off` → 回退旧 per-turn spawn→run→reap(逃生闸)。默认开(use-time 读)。 */
function serveReuseEnabled(): boolean {
  return (process.env.FORGEAX_CORE_SERVE_REUSE ?? '').trim() !== 'off';
}

export interface CreateForgeaxCoreKernelOpts {
  /** host-tool 桥定位的默认 agentPath(主对话恒 'forge')。 */
  defaultAgentPath?: string;
  /** WS 广播(observability v3 / B 档):telemetry record 经此推给浏览器 viewer。
   *  来自 main.ts 的 `hub.broadcast`(经 registerForgeaxCoreKernel 注入)。缺省 = noop
   *  (不广播,仅落盘)。 */
  broadcast?: (msg: { type: string; [k: string]: unknown }) => void;
  /** host-side telemetry 落盘 sink(默认 createTelemetryFileSink();测试可注入)。 */
  telemetrySink?: TelemetryFileSink;
  /** 反向 host-tool 执行桥(name,args,sid,agentId)→ 宿主执行工具并回结果。
   *  缺省 = makeInProcessExecuteTool(cli 内建:求 trustTier→checkKernelTool→executeTool)。
   *  外部宿主(如 forgeax-studio)注入自己的桥:跑 studio handlers + 业务接缝
   *  (ownership/roster/production),使 studio 的写类/业务工具在 studio 侧执行。 */
  hostBridge?: HostExecuteToolFn;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** per-session endpoint sock 路径:落在 `os.tmpdir()`(跨平台正确——Windows 上硬编码 `/tmp`
 *  会被按工作盘符解析成 `<drive>:\tmp`,常不存在;`os.tmpdir()` 走 TEMP/TMP/SystemRoot 回退链,
 *  恒为真实目录)。sha1 截断成短名(`fxcore-<16hex>.sock`)压住 AF_UNIX sun_path(~104)长度。 */
function deriveSock(sessionId: string): string {
  const h = createHash('sha1').update(sessionId).digest('hex').slice(0, 16);
  return join(tmpdir(), `fxcore-${h}.sock`);
}

/** 连 serve endpoint;serve 刚 spawn 需片刻才 listen → 重试到 deadline。 */
async function connectWithRetry(sock: string, signal: AbortSignal, deadlineMs = 8000): Promise<RpcConnection> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (signal.aborted) throw new Error('aborted before forgeax-core serve ready');
    try {
      return await connect(sock, 1000);
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) throw new Error(`forgeax-core serve endpoint not reachable: ${sock}`);
    await sleep(150);
  }
}

/** TurnRequest → 可序列化线上子集(去函数:requestPermission/hooks)。 */
function toWire(req: TurnRequest): Record<string, unknown> {
  return {
    session: req.session,
    callId: req.callId,
    input: req.input,
    history: req.history,
    systemPrompt: req.systemPrompt,
    tools: req.tools,
    toolPolicy: req.toolPolicy,
    budget: req.budget,
    model: req.model,
    fallbackModels: req.fallbackModels,
    trustTier: req.trustTier,
    hostSessionId: req.hostSessionId,
    // 全链路 trace:把上游 W3C traceparent 透过 unix-socket 带进 sidecar,
    //   sidecar 的 kernel.turn 据此挂成上游 span 的 child(否则在边界被丢)。
    traceparent: req.traceparent,
  };
}

/** 一轮的事件 push→pull sink(单连接多轮:按 callId 路由 notify)。 */
interface TurnSink {
  queue: KernelEvent[];
  finished: boolean;
  err: string | null;
  wake: (() => void) | null;
}

/** 一个被复用的 serve 会话(进程 + 连接 + 在飞轮 + idle 定时器)。 */
interface ServeSession {
  sessionId: string;
  conn: RpcConnection;
  /** callId → 该轮 sink(供 notify 路由)。 */
  turns: Map<string, TurnSink>;
  inflight: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 当前轮的 hostSessionId(hostTool 缺 sid 时的兜底;p.sid 优先)。 */
  hostSessionId?: string;
  /** serve 子进程 stdout/stderr → per-session logger 的退订函数(evict 时调)。 */
  offData?: () => void;
  closing: boolean;
}

/** stable serve sessionId(命名空间避免与 rented 内核(codex 等)的 sessionId 撞)。 */
function serveSessionId(key: string): string {
  return `fxcore:${key}`;
}

/** 连接式 forgeax-core 内核(经 sidecar 托管 serve 子进程,**per-session 复用**)。 */
class ForgeaxCoreServeKernel implements AgentKernel {
  readonly id = 'forgeax-core' as const;
  readonly capabilities = CAPS;
  private readonly hostBridge: HostExecuteToolFn;
  /** sessionKey → 复用中的 serve 会话。 */
  private readonly sessions = new Map<string, ServeSession>();
  /** 并发首轮去重:sessionKey → 进行中的 spawn promise。 */
  private readonly starting = new Map<string, Promise<ServeSession>>();
  /** callId → serve 会话(供 openHandle 软取消寻址)。 */
  private readonly callSession = new Map<string, ServeSession>();
  /** WS 广播(telemetry → 浏览器 viewer);未注入 = noop。 */
  private readonly broadcast: (msg: { type: string; [k: string]: unknown }) => void;
  /** host-side telemetry 落盘 sink。 */
  private readonly telemetrySink: TelemetryFileSink;

  constructor(opts: CreateForgeaxCoreKernelOpts = {}) {
    this.hostBridge = opts.hostBridge ?? makeInProcessExecuteTool(opts.defaultAgentPath ?? 'forge');
    this.broadcast = opts.broadcast ?? ((): void => {});
    this.telemetrySink =
      opts.telemetrySink ??
      createTelemetryFileSink({
        // 省略 resolveLogsDir → sink 默认走 getPathManager().session(sid).logsDir(),
        // 即注入的 SessionLayout(studio = 项目本地)。telemetry 与 WAL 同源同根,
        // 不再各算各的路径(方案B PR1 D1:删 projectSessionLogsDir,收口到 PathManager)。
        onError: (err) => tt('adapter.telemetry-sink-error', { err: String(err) }),
      });
  }

  /** out-of-band telemetry notify 路由:method==='telemetry' → 消费(落盘+广播)并返 true;
   *  否则返 false 让调用方继续走 `event` 分支。两处 onNotify 站点共用,避免重复判定。 */
  private maybeHandleTelemetry(method: string, params: unknown, hostSid: string | undefined): boolean {
    if (method !== 'telemetry') return false;
    this.handleTelemetry(params, hostSid);
    return true;
  }

  /** RPC `telemetry` notify 的处理:落盘 + 广播。**绝不抛进 RPC 层**(observability
   *  铁律:可观测性永不反噬主流程)——整体 try/catch 吞掉并经 turn-trace 上报。
   *  sid 解析:优先该 serve 会话的 hostSessionId(与 attachServeLogRouting 的
   *  `<sid>/logs/` 归属一致);缺省回落首条 record 自带的 sid。 */
  private handleTelemetry(params: unknown, hostSid: string | undefined): void {
    try {
      const records = (params as { records?: unknown })?.records;
      if (!Array.isArray(records) || records.length === 0) return;
      // 结构化容错:只保留有 'span'/'log' kind 的 record;非法形状 log-and-drop。
      const valid: TelemetryRecord[] = [];
      let dropped = 0;
      for (const r of records) {
        const kind = (r as { kind?: unknown } | null)?.kind;
        if (r && typeof r === 'object' && (kind === 'span' || kind === 'log')) {
          valid.push(r as TelemetryRecord);
        } else {
          dropped++;
        }
      }
      if (dropped > 0) tt('adapter.telemetry-dropped', { dropped, kept: valid.length });
      if (valid.length === 0) return;
      const sid = hostSid ?? (valid[0] as { sid?: string }).sid;
      // (a) 落盘:span→trace.jsonl / log→log.jsonl(sink 自己 best-effort + rotate)。
      this.telemetrySink.write(sid, valid);
      // (b) 广播:浏览器 viewer 收 `{ type:'telemetry', records }`。
      this.broadcast({ type: 'telemetry', records: valid });
    } catch (err) {
      // 永不让 telemetry 处理抛回 RPC notify 回调。
      tt('adapter.telemetry-error', { err: String(err) });
    }
  }

  private sessionKeyOf(req: TurnRequest): string {
    return `${req.hostSessionId || req.session.threadId || req.session.agentId || 'forge'}`;
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // 逃生闸:复用关闭 → 旧 per-turn 路径(spawn→run→reap)。
    if (!serveReuseEnabled()) {
      yield* this.runTurnEphemeral(req, signal);
      return;
    }

    const key = this.sessionKeyOf(req);
    const callId = req.callId ?? randomUUID();

    // 取/建复用会话;首轮 spawn 失败或半路掉线 → 驱逐后重试一次(自愈)。
    let s: ServeSession;
    try {
      s = await this.acquire(key, req, signal);
    } catch (e) {
      yield { kind: 'error', error: { code: 'protocol', message: `forgeax-core serve spawn: ${(e as Error).message}` } };
      return;
    }

    // 进入本轮:停 idle、登记 sink、记 callId→session、刷新兜底 hostSessionId。
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    s.inflight++;
    s.hostSessionId = req.hostSessionId;
    const sink: TurnSink = { queue: [], finished: false, err: null, wake: null };
    s.turns.set(callId, sink);
    this.callSession.set(callId, s);
    const poke = (): void => { if (sink.wake) { const w = sink.wake; sink.wake = null; w(); } };

    // abort → 软取消(RPC),不杀进程。
    const onAbort = (): void => { s.conn.request('cancel', { callId }).catch(() => {}); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    tt('adapter.request-sent', { key, callId, sid: req.hostSessionId, agent: req.session?.agentId });
    const done = s.conn
      .request('runTurn', toWire({ ...req, callId }))
      .then(() => { sink.finished = true; tt('adapter.done-resolved', { key, callId }); poke(); })
      .catch((e: Error) => { sink.err = e.message; sink.finished = true; tt('adapter.done-rejected', { key, callId, err: e.message }); poke(); });

    try {
      for (;;) {
        while (sink.queue.length) yield sink.queue.shift() as KernelEvent;
        if (sink.finished) { while (sink.queue.length) yield sink.queue.shift() as KernelEvent; break; }
        // idle 看门狗(纯诊断,不改行为):等待期间每 5s 打一条;若反复 tick 而始终没有
        //   done-resolved/rejected/sidecar.exit → 即「静默卡流」(本症的核心嫌疑)。
        const waitStart = Date.now();
        const iv = ttEnabled()
          ? setInterval(() => {
              tt('adapter.idle', { key, callId, waitedMs: Date.now() - waitStart, queue: sink.queue.length, finished: sink.finished });
            }, 5000)
          : null;
        (iv as { unref?: () => void } | null)?.unref?.();
        try {
          await new Promise<void>((r) => { sink.wake = r; });
        } finally {
          if (iv) clearInterval(iv);
        }
      }
      await done;
      if (sink.err) {
        // 连接掉线(serve 崩)→ 驱逐该 session,下一轮自动重 spawn。
        if (/connection closed|not reachable/i.test(sink.err)) this.evict(key, s, /*reap*/ false);
        yield { kind: 'error', error: { code: 'protocol', message: `forgeax-core serve: ${sink.err}` } };
      }
    } finally {
      s.turns.delete(callId);
      this.callSession.delete(callId);
      s.inflight = Math.max(0, s.inflight - 1);
      if (s.inflight === 0 && !s.closing && this.sessions.get(key) === s) this.armIdle(key, s);
    }
  }

  /**
   * cache-safe fork 提取(编排层 turnEnd 驱动):**只复用已存在的 serve 会话**(刚跑完轮 → 会话活、
   * 缓存热)发 forkExtract RPC;无会话/复用关 → 返回 ok:false,让编排层(soul)冷兜底(§9)。
   * 不为提取 spawn 新会话(那既无缓存收益、又徒增进程)。
   */
  async forkExtract(req: ForkExtractRequest, _signal: AbortSignal): Promise<ForkExtractResult> {
    const miss: ForkExtractResult = { ok: false, toolCalls: 0, writtenPaths: [] };
    if (!serveReuseEnabled()) return miss;
    const key = this.sessionKeyOf(req as unknown as TurnRequest);
    const s = this.sessions.get(key);
    if (!s || s.closing) return miss;
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    s.inflight++;
    try {
      const res = (await s.conn.request('forkExtract', req as unknown as Record<string, unknown>)) as ForkExtractResult;
      return res ?? miss;
    } catch {
      return miss;
    } finally {
      s.inflight = Math.max(0, s.inflight - 1);
      if (s.inflight === 0 && !s.closing && this.sessions.get(key) === s) this.armIdle(key, s);
    }
  }

  /** 取已有复用会话或新建(并发首轮去重)。 */
  private acquire(key: string, req: TurnRequest, signal: AbortSignal): Promise<ServeSession> {
    const existing = this.sessions.get(key);
    if (existing && !existing.closing) return Promise.resolve(existing);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const p = this.spawnSession(key, req, signal).finally(() => this.starting.delete(key));
    this.starting.set(key, p);
    return p;
  }

  /** spawn serve 子进程 + 连接 + 装一次性 notify/hostTool/onExit 处理器。 */
  private async spawnSession(key: string, req: TurnRequest, signal: AbortSignal): Promise<ServeSession> {
    const sessionId = serveSessionId(key);
    const endpoint = deriveSock(sessionId);
    const projectRoot = process.env.FORGEAX_PROJECT_ROOT ?? process.cwd();
    const sidecar = await ensureSidecar();

    // cred-vault 注 scoped token(真 key 经 stripModelKeys 剔除不外发)。budget 作 session 级。
    const grant = await sidecar.startSession({
      sessionId,
      agentId: req.session.agentId || 'forge',
      trustTier: req.trustTier ?? 'own',
      callId: sessionId,
      ...(req.budget ? { budget: req.budget } : {}),
      endpoint,
      kernel: {
        kind: 'forgeax-core',
        credential: 'sidecar-managed',
        serveMode: true,
        ...coreLaunch(endpoint),
        cwd: projectRoot,
        env: stripModelKeys(materializeEnv()),
      },
    });

    const conn = await connectWithRetry(grant.endpoint ?? endpoint, signal);
    const s: ServeSession = { sessionId, conn, turns: new Map(), inflight: 0, idleTimer: null, closing: false };

    // 一次性 notify:按 callId 路由事件到对应轮的 sink;telemetry 走旁路(落盘+广播)。
    conn.onNotify((method, params) => {
      // observability v3 / B 档:out-of-band telemetry 通道(与 `event` 平行)。
      if (this.maybeHandleTelemetry(method, params, s.hostSessionId)) return;
      if (method !== 'event') return;
      const { callId, event } = (params ?? {}) as { callId?: string; event?: KernelEvent };
      if (!event) return;
      const sink = callId ? s.turns.get(callId) : undefined;
      if (sink) { sink.queue.push(event); if (sink.wake) { const w = sink.wake; sink.wake = null; w(); } }
    });

    // 一次性反向 host-tool:p.sid 优先,缺省用当前轮兜底 hostSessionId。
    conn.setRequestHandler(async (method, params) => {
      if (method === 'hostTool') {
        const p = (params ?? {}) as { name: string; args: unknown; sid?: string; agentId?: string };
        // p.agentId = facade 透来的本轮真实 agent(委派轮 = mochi 等);桥按它求 trustTier / 弹卡 / 选 context。
        return this.hostBridge(p.name, p.args, p.sid ?? s.hostSessionId, p.agentId);
      }
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
    });

    // 崩溃自愈:serve 进程退出 → 驱逐该 session(下轮自动重 spawn)。一次性。
    const off = sidecar.onExit((info: { sessionId: string }) => {
      if (info.sessionId !== sessionId) return;
      tt('sidecar.exit', { key, sessionId, inflight: s.inflight, openTurns: s.turns.size });
      off();
      this.evict(key, s, /*reap*/ false);
    });

    // serve 子进程 stdout/stderr → per-session logger:还原迁到 sidecar 前 console.* 落
    //   `<sid>/logs/debug.log` 的可观测性。迁移后核心链路跑进 serve 子进程,其 stdout/stderr
    //   原本只经 onData 飘回却无人消费(默认复用路径不订阅)→ 链路日志丢失。这里补上接线。
    s.offData = this.attachServeLogRouting(sidecar, sessionId, req.hostSessionId, req.session.agentId || 'forge');

    this.sessions.set(key, s);
    return s;
  }

  /** serve 子进程 stdout/stderr → 该 host session 的 logger(`<sid>/logs/debug.log`
   *  + stderr 走 INFO 也进 `latest.log`)。按 sessionId 过滤本会话、按行切(半行缓存)、
   *  复用已注册的 per-session Logger(自带 stream/rotation,无二次写者竞争);hostSid 缺失
   *  时回落 global logger(user-root debug.log)。best-effort,永不抛。返回退订函数。 */
  private attachServeLogRouting(
    sidecar: Awaited<ReturnType<typeof ensureSidecar>>,
    serveSid: string,
    hostSid: string | undefined,
    agentId: string,
  ): () => void {
    const buf: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
    const flush = (stream: 'stdout' | 'stderr', chunk: string): void => {
      try {
        const snap = getConsoleRouterSnapshot();
        const logger = (hostSid ? snap.sessions.get(hostSid) : undefined) ?? snap.global;
        if (!logger) return;
        buf[stream] += chunk;
        let nl: number;
        while ((nl = buf[stream].indexOf('\n')) >= 0) {
          const line = buf[stream].slice(0, nl);
          buf[stream] = buf[stream].slice(nl + 1);
          if (!line.trim()) continue;
          const msg = `[serve:${stream}] ${line}`;
          // stderr → INFO(也进 latest.log,作关键信号);stdout → DEBUG(仅 debug.log 全量)。
          if (stream === 'stderr') logger.info(agentId, undefined, msg);
          else logger.debug(agentId, undefined, msg);
        }
      } catch {
        /* 诊断日志绝不能影响主流程 */
      }
    };
    return sidecar.onData(({ sessionId, stream, chunk }) => {
      if (sessionId !== serveSid) return;
      flush(stream, chunk);
    });
  }

  /** 起 idle 回收定时器(到期 reap 进程)。 */
  private armIdle(key: string, s: ServeSession): void {
    const ms = serveIdleMs();
    if (ms <= 0) return; // 0/负 → 永不 idle 回收(测试可设 <=0 关闭)
    const t = setTimeout(() => { this.evict(key, s, /*reap*/ true); }, ms);
    (t as { unref?: () => void }).unref?.(); // 不阻塞进程退出
    s.idleTimer = t;
  }

  /** 驱逐复用会话:从表中移除、关连接;reap=true 时再 shutdownSession(idle 路径)。 */
  private evict(key: string, s: ServeSession, reap: boolean): void {
    if (s.closing) return;
    tt('adapter.evict', { key, sessionId: s.sessionId, reap, inflight: s.inflight, openTurns: s.turns.size });
    s.closing = true;
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (this.sessions.get(key) === s) this.sessions.delete(key);
    try { s.offData?.(); } catch { /* ignore */ }
    try { s.conn.close(); } catch { /* ignore */ }
    // 回收该 session 的 telemetry 字节计数缓存,避免 byteCounters 随 session 数单调增长。
    try { this.telemetrySink.evict(s.hostSessionId); } catch { /* ignore */ }
    if (reap) ensureSidecar().then((sc) => sc.shutdownSession(s.sessionId)).catch(() => {});
  }

  /** 旧 per-turn 路径(逃生闸 FORGEAX_CORE_SERVE_REUSE=off);spawn→run→reap。 */
  private async *runTurnEphemeral(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const callId = req.callId ?? randomUUID();
    const sessionId = `${req.hostSessionId || req.session.threadId || req.session.agentId || 'forge'}::${callId}`;
    const endpoint = deriveSock(sessionId);
    const projectRoot = process.env.FORGEAX_PROJECT_ROOT ?? process.cwd();
    const sidecar = await ensureSidecar();
    const grant = await sidecar.startSession({
      sessionId,
      agentId: req.session.agentId || 'forge',
      trustTier: req.trustTier ?? 'own',
      callId,
      ...(req.budget ? { budget: req.budget } : {}),
      endpoint,
      kernel: {
        kind: 'forgeax-core', credential: 'sidecar-managed', serveMode: true,
        ...coreLaunch(endpoint),
        cwd: projectRoot, env: stripModelKeys(materializeEnv()),
      },
    });
    const conn = await connectWithRetry(grant.endpoint ?? endpoint, signal);
    this.callSession.set(callId, { sessionId, conn, turns: new Map(), inflight: 1, idleTimer: null, closing: false });
    // serve 子进程 stdout/stderr → per-session logger(同复用路径;逃生闸亦保留可观测性)。
    const offData = this.attachServeLogRouting(sidecar, sessionId, req.hostSessionId, req.session.agentId || 'forge');
    conn.setRequestHandler(async (method, params) => {
      if (method === 'hostTool') {
        const p = (params ?? {}) as { name: string; args: unknown; sid?: string; agentId?: string };
        // p.agentId 优先(facade 透来的本轮真实 agent);缺省回落本轮 req 的 session.agentId。
        return this.hostBridge(p.name, p.args, p.sid ?? req.hostSessionId, p.agentId ?? req.session?.agentId);
      }
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
    });
    const queue: KernelEvent[] = [];
    let finished = false; let errMsg: string | null = null; let wake: (() => void) | null = null;
    const poke = (): void => { if (wake) { const w = wake; wake = null; w(); } };
    conn.onNotify((method, params) => {
      // observability v3 / B 档:out-of-band telemetry 通道(与 `event` 平行)。
      if (this.maybeHandleTelemetry(method, params, req.hostSessionId)) return;
      if (method !== 'event') return;
      const { event } = (params ?? {}) as { event?: KernelEvent };
      if (event) { queue.push(event); poke(); }
    });
    const onAbort = (): void => { conn.request('cancel', { callId }).catch(() => {}); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const done = conn.request('runTurn', toWire({ ...req, callId }))
      .then(() => { finished = true; poke(); })
      .catch((e: Error) => { errMsg = e.message; finished = true; poke(); });
    try {
      for (;;) {
        while (queue.length) yield queue.shift() as KernelEvent;
        if (finished) { while (queue.length) yield queue.shift() as KernelEvent; break; }
        await new Promise<void>((r) => { wake = r; });
      }
      await done;
      if (errMsg) yield { kind: 'error', error: { code: 'protocol', message: `forgeax-core serve: ${errMsg}` } };
    } finally {
      this.callSession.delete(callId);
      try { offData(); } catch { /* ignore */ }
      try { conn.close(); } catch { /* ignore */ }
      sidecar.shutdownSession(sessionId).catch(() => {});
    }
  }

  openHandle(callId: string): TurnHandle {
    const conn = (): RpcConnection | undefined => this.callSession.get(callId)?.conn;
    return {
      async setPermissionMode(mode): Promise<void> { await conn()?.request('setPermissionMode', { callId, mode }).catch(() => {}); },
      async setModel(model): Promise<void> { await conn()?.request('setModel', { callId, model }).catch(() => {}); },
      async interrupt(): Promise<void> { await conn()?.request('interrupt', { callId }).catch(() => {}); },
      async cancel(): Promise<void> { await conn()?.request('cancel', { callId }).catch(() => {}); },
    };
  }

  async probe(): Promise<KernelHealth> {
    return { ok: true, kernelId: this.id, detail: `forgeax-core (sidecar serve, reuse=${serveReuseEnabled() ? 'on' : 'off'})` };
  }
}

/** 组合连接式 forgeax-core 内核(测试可注入 opts)。 */
export function createForgeaxCoreKernel(opts: CreateForgeaxCoreKernelOpts = {}): AgentKernel {
  return new ForgeaxCoreServeKernel(opts);
}

/** 把连接式 forgeax-core 内核注册进共享 registry(幂等:已注册则跳过)。
 *  `opts.broadcast` 由产品壳(main.ts)注入 `hub.broadcast`,使 telemetry 能推给浏览器。 */
export function registerForgeaxCoreKernel(opts: CreateForgeaxCoreKernelOpts = {}): void {
  if (getKernel('forgeax-core')) return;
  registerKernel(createForgeaxCoreKernel(opts));
}
