/**
 * 环回凭据代理(凭据地板 C0-a)—— 让 imported 子进程**拿不到真模型 key**。
 *
 * 威胁模型(规格 §4 命门):imported pack 可能被劫持 → 若真 ANTHROPIC_API_KEY /
 * OPENAI_API_KEY 在它的子进程 env 里,就能被偷走。本代理把真 key 留在宿主:
 *   - 宿主在 `127.0.0.1:<随机端口>` 起一个**透明转发** HTTP server。
 *   - 每个 imported turn 发一个一次性 nonce(`issueToken`);子进程 env 只拿到
 *     `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` + `ANTHROPIC_API_KEY=<nonce>`。
 *   - CLI 把请求打到环回代理(带 nonce);代理校验 nonce → 换上**真 key** → 转发到
 *     真 upstream(`ANTHROPIC_BASE_URL` 或 api.anthropic.com)→ 流式回传。
 *   - turn 结束 `revokeToken` 撤销 nonce。真 key 永不出宿主、永不入子进程。
 *
 * 残留(deferred,需 sidecar 文件系统沙箱):OAuth 登录态(`~/.claude.json`/
 * `~/.codex/auth.json`)是磁盘文件,imported 仍能读 —— 本代理只堵 env-key 这条路;
 * 文件层隔离要进程沙箱(R3),非本模块。own/forge 信任 → 不经代理(直连)。
 *
 * 透明转发:原样转发 method/path/query/body + 大部分 header,只替换鉴权头。不解析
 * 厂商 body 形状(适配 anthropic `/v1/messages` 与 openai `/v1/*` 皆可)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

type Provider = 'anthropic' | 'openai';

interface TokenEntry {
  provider: Provider;
  /** 真 key(从宿主 env 读;子进程永不见)。 */
  realKey: string;
  /** 真 upstream base(无尾斜杠)。 */
  upstream: string;
}

const DEBUG = process.env.FORGEAX_CRED_PROXY_DEBUG;
const dbg = (m: string) => { if (DEBUG) { try { process.stderr.write(`[cred-proxy] ${m}\n`); } catch { /* ignore */ } } };

const tokens = new Map<string, TokenEntry>();
let server: Server | null = null;
let port = 0;
let starting: Promise<void> | null = null;

/** 默认 upstream(env 未配代理时)。 */
function defaultUpstream(provider: Provider): string {
  if (provider === 'anthropic') {
    return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  }
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
}

/** 从请求头取 nonce(anthropic=x-api-key;openai=Authorization: Bearer)。 */
function extractNonce(headers: IncomingMessage['headers']): string | undefined {
  const xApiKey = headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'content-encoding', 'x-api-key', 'authorization', 'keep-alive',
]);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nonce = extractNonce(req.headers);
  const entry = nonce ? tokens.get(nonce) : undefined;
  if (!entry) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'cred-proxy: invalid or revoked token' }));
    dbg(`401 (nonce ${nonce ? 'unknown' : 'missing'})`);
    return;
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  // 转发头:复制非 hop-by-hop;注入真 key。
  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === 'string') fwdHeaders[k] = v;
    else if (Array.isArray(v)) fwdHeaders[k] = v.join(', ');
  }
  if (entry.provider === 'anthropic') fwdHeaders['x-api-key'] = entry.realKey;
  else fwdHeaders['authorization'] = `Bearer ${entry.realKey}`;

  const upstreamUrl = `${entry.upstream}${req.url ?? '/'}`;
  dbg(`forward ${req.method} ${req.url} → ${entry.upstream} (nonce→realKey swap)`);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: body && body.length > 0 ? body : undefined,
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `cred-proxy upstream error: ${(e as Error).message}` }));
    return;
  }

  // 回传:status + 非 hop-by-hop 响应头;流式 body(SSE 透传)。
  const respHeaders: Record<string, string> = {};
  upstreamResp.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders[key] = value;
  });
  res.writeHead(upstreamResp.status, respHeaders);
  if (upstreamResp.body) {
    try {
      for await (const chunk of upstreamResp.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    } catch {
      /* 上游流中断 → 结束响应 */
    }
  }
  res.end();
}

async function ensureStarted(): Promise<void> {
  if (server) return;
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    const s = createServer((req, res) => { void handle(req, res); });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      server = s;
      dbg(`listening on 127.0.0.1:${port}`);
      resolve();
    });
  });
  return starting;
}

/** 发一次性 nonce + 环回 baseUrl。真 key 从宿主 env 读,子进程永不见。
 *  返回 null 表示该 provider 在宿主无 env key(如 OAuth 登录态)→ 调用方应回退
 *  (本切片:无 env key 则不启代理,留待 sidecar 文件层方案)。 */
export async function issueToken(provider: Provider): Promise<{ token: string; baseUrl: string } | null> {
  const realKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!realKey || !realKey.trim()) return null;
  await ensureStarted();
  const token = `fxk-${randomUUID()}`;
  tokens.set(token, { provider, realKey: realKey.trim(), upstream: defaultUpstream(provider) });
  return { token, baseUrl: `http://127.0.0.1:${port}` };
}

/** 撤销 nonce(turn 结束调用)。 */
export function revokeToken(token: string): void {
  tokens.delete(token);
}

/** 测试/关停用:关闭代理 server + 清空 token。 */
export function closeCredProxy(): Promise<void> {
  tokens.clear();
  const s = server;
  server = null;
  starting = null;
  port = 0;
  return new Promise((resolve) => {
    if (!s) return resolve();
    s.close(() => resolve());
  });
}
