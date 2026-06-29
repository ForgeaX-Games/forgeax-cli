/** /api/events — Phase D5.
 *
 *  GET  /api/events/recent?topic=<glob>&n=<int>  → EventEnvelope[]
 *  POST /api/events/emit                          → manual emit (debugging /
 *                                                   skill-runner pre-D4)
 *  GET  /api/events/stream?topic=<glob>           → SSE fanout
 *
 *  Emit accepts `{ topic, payload, threadId? }`. SSE is a one-shot live tap;
 *  callers needing replay use /recent. */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getEventBus } from '../events/bus';

export function createEventsRouter() {
  const r = new Hono();

  r.get('/recent', (c) => {
    const topic = c.req.query('topic') || '*';
    const n = Number(c.req.query('n') || '50');
    const events = getEventBus().recent(topic, Number.isFinite(n) ? n : 50);
    return c.json({ events });
  });

  r.post('/emit', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.topic !== 'string') {
      return c.json({ ok: false, error: 'topic (string) required' }, 400);
    }
    const env = getEventBus().emit(body.topic, body.payload ?? null, {
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
    });
    return c.json({ ok: true, env });
  });

  r.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      const topic = c.req.query('topic') || '*';
      const unsub = getEventBus().subscribe(topic, async (env) => {
        await stream.writeSSE({ event: 'event', data: JSON.stringify(env) });
      });
      stream.onAbort(() => unsub());
      // Keep the stream open; SSE clients close from their side.
      // Periodic heartbeat so reverse proxies don't kill idle connections.
      while (true) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
    }),
  );

  return r;
}
