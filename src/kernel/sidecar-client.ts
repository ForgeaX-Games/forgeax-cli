/**
 * sidecar-client —— server(编排层)侧连 ring-0 sidecar(`@forgeax/agent-host`)的 JSON-RPC 客户端。
 *
 * 本阶段(R3 阶段1):**只提供 client + 冒烟连通,不接内核热路径**。后续 S1b 把内核 spawn
 * 改走 sidecar 时,kernel 经此 client 申请进程组 + 取消 + 收 onExit。
 *
 * 自包含:不 import `@forgeax/agent-host`(避免跨 submodule workspace 依赖),只镜像同款
 * newline-JSON-RPC 线协议 + 控制面方法形状。
 */
import { connect as netConnect, type Socket } from 'node:net';
import { tt } from '../lib/turn-trace';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TrustTier = 'own' | 'imported';

export interface KernelSpawnSpec {
  kind: string;
  credential: 'sidecar-managed' | 'user-managed';
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** serve 模式(forgeax-core --serve):数据面走 endpoint sock,不走 stdout-JSONL。 */
  serveMode?: boolean;
}
export interface StartSessionReq {
  sessionId: string;
  agentId: string;
  trustTier: TrustTier;
  callId?: string;
  budget?: { maxTokens?: number; maxBudgetUsd?: number; deadlineMs?: number; maxTurns?: number };
  kernel: KernelSpawnSpec;
  /** serve 模式:per-session unix-sock 路径(adapter 提供,Host 回显)。 */
  endpoint?: string;
}
export interface SessionGrant { sessionId: string; pid: number; pgid: number; scopedToken?: string; baseUrl?: string; endpoint?: string }
export interface ExitInfo { sessionId: string; code: number | null; signal: string | null; reason: string }
export interface PingResult { pid: number; uptimeMs: number; version: string; sessions: number }

export function defaultSockPath(): string {
  return process.env.FORGEAX_AGENT_HOST_SOCK?.trim() || join(homedir(), '.forgeax', 'agent-host.sock');
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** 一条到 sidecar 的连接 + JSON-RPC 客户端。 */
export class SidecarClient {
  private sock: Socket | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly exitCbs = new Set<(info: ExitInfo) => void>();
  private readonly dataCbs = new Set<(d: { sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void>();

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', (c: Buffer) => this.ingest(c));
    sock.on('error', () => {});
    sock.on('close', () => {
      tt('sidecar.socket-close', { pendingRejected: this.pending.size });
      for (const p of this.pending.values()) p.reject(new Error('sidecar connection closed'));
      this.pending.clear();
      this.sock = null;
    });
  }

  /** 连到 sidecar;socket 不存在 → reject(调用方决定是否 spawn sidecar 后重试)。 */
  static connect(sockPath = defaultSockPath(), timeoutMs = 2000): Promise<SidecarClient> {
    return new Promise((resolve, reject) => {
      let sock: Socket;
      try { sock = netConnect(sockPath); } catch (e) { reject(e as Error); return; }
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('sidecar connect timeout')); }, timeoutMs);
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
      sock.once('connect', () => { clearTimeout(timer); resolve(new SidecarClient(sock)); });
    });
  }

  private ingest(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id); if (!p) continue; this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.method === 'exit') {
        tt('sidecar.exit-msg', { params: msg.params });
        for (const cb of this.exitCbs) { try { cb(msg.params as ExitInfo); } catch { /* ignore */ } }
      } else if (msg.method === 'data') {
        for (const cb of this.dataCbs) { try { cb(msg.params as { sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }); } catch { /* ignore */ } }
      }
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.sock) return Promise.reject(new Error('sidecar not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    });
  }

  ping(): Promise<PingResult> { return this.request('ping') as Promise<PingResult>; }
  startSession(req: StartSessionReq): Promise<SessionGrant> { return this.request('startSession', req) as Promise<SessionGrant>; }
  cancel(callId: string): Promise<void> { return this.request('cancel', { callId }) as Promise<void>; }
  shutdownSession(sessionId: string): Promise<void> { return this.request('shutdownSession', { sessionId }) as Promise<void>; }
  getProcess(sessionId: string): Promise<{ pid: number; pgid: number } | null> { return this.request('getProcess', { sessionId }) as Promise<{ pid: number; pgid: number } | null>; }
  listSessions(): Promise<unknown[]> { return this.request('listSessions') as Promise<unknown[]>; }
  onExit(cb: (info: ExitInfo) => void): () => void { this.exitCbs.add(cb); return () => this.exitCbs.delete(cb); }
  onData(cb: (d: { sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void): () => void { this.dataCbs.add(cb); return () => this.dataCbs.delete(cb); }
  close(): void { try { this.sock?.end(); this.sock?.destroy(); } catch { /* ignore */ } }
}
