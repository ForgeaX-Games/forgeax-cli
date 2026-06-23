/**
 * DUAL-MODALITY 9.8 - bulk surface snapshot replay.
 *
 * GET /api/bus/ui/surfaces/snapshots returns the current snapshot of every
 * registered surface in one round-trip. Used by the chat session on boot
 * (or reconnect) to inject "what the player sees right now" into the AI
 * prompt context, so the AI does not have to re-discover state.
 *
 * Surfaces with snapshot===null are skipped (not yet populated by panel).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createBusRouter } from '../src/api/bus';

function freshApp(): Hono {
  const app = new Hono();
  app.route('/api/bus', createBusRouter());
  return app;
}

async function registerSurface(app: Hono, body: { id: string; initialSnapshot?: unknown; layer?: string }): Promise<void> {
  const r = await app.request('/api/bus/ui/surfaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`register ${body.id} failed: ${r.status}`);
}

describe('GET /api/bus/ui/surfaces/snapshots - DUAL-MODALITY 9.8', () => {
  let app: Hono;
  beforeEach(async () => {
    app = freshApp();
    // Clean slate for each test by deleting any leftovers; the Map is
    // module-scoped so prior tests can leak. Touch each id we will reuse.
    for (const id of ['ui9.8.a', 'ui9.8.b', 'ui9.8.empty']) {
      await app.request(`/api/bus/ui/surfaces/${id}`, { method: 'DELETE' });
    }
  });

  it('returns snapshots of all registered surfaces with non-null snapshot', async () => {
    await registerSurface(app, { id: 'ui9.8.a', initialSnapshot: { tab: 'workbench' } });
    await registerSurface(app, { id: 'ui9.8.b', initialSnapshot: { selected: 'fox' } });

    const r = await app.request('/api/bus/ui/surfaces/snapshots');
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<{ id: string; snapshot: unknown }>; count: number };

    const got = new Map(j.items.map((it) => [it.id, it.snapshot]));
    expect(got.get('ui9.8.a')).toEqual({ tab: 'workbench' });
    expect(got.get('ui9.8.b')).toEqual({ selected: 'fox' });
    expect(j.count).toBeGreaterThanOrEqual(2);
  });

  it('skips surfaces whose snapshot is still null', async () => {
    await registerSurface(app, { id: 'ui9.8.empty' });
    const r = await app.request('/api/bus/ui/surfaces/snapshots');
    const j = (await r.json()) as { items: Array<{ id: string }> };
    expect(j.items.find((it) => it.id === 'ui9.8.empty')).toBeUndefined();
  });

  it('reflects PUT /snapshot updates in subsequent replay calls', async () => {
    await registerSurface(app, { id: 'ui9.8.a', initialSnapshot: { v: 1 } });
    await app.request('/api/bus/ui/surfaces/ui9.8.a/snapshot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: { v: 2 } }),
    });
    const r = await app.request('/api/bus/ui/surfaces/snapshots');
    const j = (await r.json()) as { items: Array<{ id: string; snapshot: { v: number } }> };
    const a = j.items.find((it) => it.id === 'ui9.8.a');
    expect(a?.snapshot).toEqual({ v: 2 });
  });
});
