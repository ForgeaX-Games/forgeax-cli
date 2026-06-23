/**
 * /api/wb/bgm —— residual host route for the Music & BGM plugin.
 *
 * wb-bgm's LOGIC (library search / attach / manifest / raw passthrough) has
 * MOVED into the marketplace plugin @forgeax-plugin/wb-bgm (server/tool-handlers.ts
 * + src/core.ts), reachable via the Host ToolRegistry (/api/tools/call) for both
 * humans (SPA, caller.kind='user') and AI (native kit forward + CLI MCP).
 *
 * Only ONE route remains here: `/cos-proxy`, a GENERIC binary stream + Range +
 * CORS shield used by the SPA's <audio> preview and zip download. It carries no
 * bgm business logic or credentials (it just proxies an https URL), so it stays
 * host-side rather than forcing the plugin to run a standalone HTTP backend.
 */

import { Hono } from 'hono';

export function createBgmRouter(): Hono {
  const r = new Hono();

  // COS blob proxy (CORS shield). Forwards the client's Range header so
  // <audio>/<video> can learn the total duration (via Content-Range) and seek;
  // passes the upstream status (200 or 206) through instead of forcing 200.
  r.get('/cos-proxy', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'missing-url' }, 400);
    if (!/^https?:\/\//.test(url)) return c.json({ error: 'invalid-url' }, 400);
    const range = c.req.header('range');
    let resp: Response;
    try {
      resp = await fetch(url, range ? { headers: { Range: range } } : undefined);
    } catch (e) {
      return c.json({ error: 'upstream-failed', message: (e as Error).message }, 502);
    }
    if (!resp.ok && resp.status !== 206) return c.text(`upstream returned ${resp.status}`, resp.status as 502);
    const headers = new Headers();
    headers.set('content-type', resp.headers.get('content-type') || 'application/octet-stream');
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag'] as const) {
      const v = resp.headers.get(h);
      if (v) headers.set(h, v);
    }
    const acceptRanges = resp.headers.get('accept-ranges');
    if (acceptRanges) headers.set('accept-ranges', acceptRanges);
    else if (resp.status === 206 || resp.headers.get('content-range')) headers.set('accept-ranges', 'bytes');
    headers.set('access-control-allow-origin', '*');
    headers.set('cache-control', 'public, max-age=3600');
    return new Response(resp.body, { status: resp.status, headers });
  });

  return r;
}
