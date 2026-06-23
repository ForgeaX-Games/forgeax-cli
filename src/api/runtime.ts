/** /api/runtime — Doc 07 §TopBar Pause backend.
 *
 *   GET  /api/runtime/pause          → { paused, changedAt }
 *   POST /api/runtime/pause          → body { paused: boolean, reason?: string }
 *
 *  The TopBar UI reads/sets this and reflects the indicator. AI-initiated
 *  tool calls (`callTool` with caller.kind='ai') and skill runs are gated
 *  on `isPaused()` and short-circuit with code:'paused' when set.
 */
import { Hono } from 'hono';
import { getPauseState, setPaused } from '../runtime/pause';

export function createRuntimeRouter() {
  const r = new Hono();

  r.get('/pause', (c) => c.json(getPauseState()));

  r.post('/pause', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.paused !== 'boolean') {
      return c.json({ ok: false, error: 'paused: boolean required' }, 400);
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const state = setPaused(body.paused, reason);
    return c.json({ ok: true, ...state });
  });

  return r;
}
