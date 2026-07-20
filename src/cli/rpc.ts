/**
 * rpc —— newline-delimited JSON-RPC 2.0 over unix-socket(`node:net`),core 侧自包含副本。
 *
 * 与 `@forgeax/agent-host/src/ipc.ts` 的 `RpcConnection` 同款线协议(frame = 一行 JSON + `\n`,
 * 请求/响应按 id 关联 + 单向通知)。**core 边界禁止 import agent-host**,故这里复制一份最小
 * 实现(仅 node:net),供 forgeax-core `--serve` 数据面用;adapter 侧仍用 agent-host 的同款。
 *
 * Boundary: 仅 node:net + node:string_decoder。
 */
import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface RpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export interface RpcNotify { jsonrpc: '2.0'; method: string; params?: unknown }
export interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }
type RpcMessage = RpcRequest | RpcNotify | RpcResponse;

function encodeFrame(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

/** 半包/粘包安全:喂 chunk,吐完整消息。
 *  ⚠️ 用 StringDecoder(而非 `chunk.toString('utf8')`)解 Buffer:socket 分片可能落在
 *  多字节 UTF-8 序列中间,`toString` 会把不完整尾字节解成 `U+FFFD` 并丢字节,大 charter
 *  静默损坏中文(见验收报告 A.5)。StringDecoder 把不完整尾字节缓到下一片再解。 */
function createFrameParser(): (chunk: Buffer | string) => RpcMessage[] {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const out: RpcMessage[] = [];
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as RpcMessage); } catch { /* drop malformed frame */ }
    }
    return out;
  };
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotifyHandler = (method: string, params: unknown) => void;

/** 一条连接上的双向 JSON-RPC 端点。 */
export class RpcConnection {
  private readonly parse = createFrameParser();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reqHandler: RequestHandler | null = null;
  private notifyHandler: NotifyHandler | null = null;
  private closed = false;

  constructor(private readonly sock: Socket) {
    sock.on('data', (chunk) => { for (const msg of this.parse(chunk)) void this.dispatch(msg); });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
    });
  }

  /** 连接是否仍存活(底层 socket 未 close)。消费者复用前据此探测直连,socket
   *  被动关闭(sidecar 重启 / serve 崩溃)后可主动驱逐而非白丢一轮。 */
  get isOpen(): boolean { return !this.closed; }

  setRequestHandler(h: RequestHandler): void { this.reqHandler = h; }
  onNotify(h: NotifyHandler): void { this.notifyHandler = h; }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    try { this.sock.end(); } catch { /* ignore */ }
    try { this.sock.destroy(); } catch { /* ignore */ }
  }

  private send(msg: RpcMessage): void {
    try { this.sock.write(encodeFrame(msg)); } catch { /* socket gone */ }
  }

  private async dispatch(msg: RpcMessage): Promise<void> {
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if ('id' in msg) {
      const req = msg as RpcRequest;
      if (!this.reqHandler) {
        this.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no handler' } });
        return;
      }
      try {
        const result = await this.reqHandler(req.method, req.params);
        this.send({ jsonrpc: '2.0', id: req.id, result: result ?? null });
      } catch (e) {
        const code = (e as { code?: number }).code ?? -32603;
        this.send({ jsonrpc: '2.0', id: req.id, error: { code, message: (e as Error).message } });
      }
      return;
    }
    this.notifyHandler?.((msg as RpcNotify).method, (msg as RpcNotify).params);
  }
}

/** 在 unix-socket 上起 RPC server,每条连接回调一个 `RpcConnection`。返回底层 net.Server。 */
export function listenRpc(sockPath: string, onConnection: (conn: RpcConnection, sock: Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => onConnection(new RpcConnection(sock), sock));
    server.on('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}
