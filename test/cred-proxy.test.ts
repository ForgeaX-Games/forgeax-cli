/** 环回凭据代理单测(C0-a):nonce 不含真 key;校验 + 真 key 注入转发;非法/撤销 → 401。 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { issueToken, revokeToken, closeCredProxy } from '../src/kernel/cred-proxy';

const REAL_KEY = 'sk-ant-REAL-secret-do-not-leak';
let upstream: Server | null = null;
let savedKey: string | undefined;
let savedBase: string | undefined;

async function startUpstream(): Promise<{ url: string; received: () => string | undefined }> {
  let receivedKey: string | undefined;
  upstream = createServer((req, res) => {
    receivedKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echoPath: req.url }));
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const addr = upstream!.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, received: () => receivedKey };
}

afterEach(async () => {
  await closeCredProxy();
  if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedBase;
});

describe('cred-proxy C0-a', () => {
  test('token 是 nonce(非真 key)+ 环回 baseUrl;真 key 注入转发到 upstream', async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    const up = await startUpstream();
    process.env.ANTHROPIC_API_KEY = REAL_KEY;
    process.env.ANTHROPIC_BASE_URL = up.url; // 代理 upstream 指向 stub

    const issued = await issueToken('anthropic');
    expect(issued).not.toBeNull();
    const { token, baseUrl } = issued!;
    expect(token).not.toBe(REAL_KEY);            // 子进程拿到的是 nonce,不是真 key
    expect(token.startsWith('fxk-')).toBe(true);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // 模拟 CLI:带 nonce 打到环回代理 /v1/messages。
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { ok: boolean; echoPath: string };
    expect(j.ok).toBe(true);
    expect(j.echoPath).toBe('/v1/messages');     // 路径透传
    expect(up.received()).toBe(REAL_KEY);        // upstream 收到的是真 key(代理注入)
  });

  test('非法 nonce → 401', async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    const up = await startUpstream();
    process.env.ANTHROPIC_API_KEY = REAL_KEY;
    process.env.ANTHROPIC_BASE_URL = up.url;
    const { baseUrl } = (await issueToken('anthropic'))!;

    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': 'bogus-nonce' }, body: '{}',
    });
    expect(resp.status).toBe(401);
    expect(up.received()).toBeUndefined(); // 从未转发
  });

  test('revoke 后 → 401', async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    const up = await startUpstream();
    process.env.ANTHROPIC_API_KEY = REAL_KEY;
    process.env.ANTHROPIC_BASE_URL = up.url;
    const { token, baseUrl } = (await issueToken('anthropic'))!;
    revokeToken(token);

    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': token }, body: '{}',
    });
    expect(resp.status).toBe(401);
  });

  test('宿主无 env key → issueToken 返回 null(回退,不启代理)', async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await issueToken('anthropic')).toBeNull();
  });
});
