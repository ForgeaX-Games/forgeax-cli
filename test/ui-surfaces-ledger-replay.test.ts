/**
 * DUAL-MODALITY 9.8 ledger replay - surface lifecycle events emit onto the
 * EventBus ring buffer. /api/events/recent?topic=ui.surface.*&n=N is the
 * replay path: chat session boots, asks "what did the player do since I left",
 * gets the action history without re-discovering current state.
 *
 * Topics:
 *   ui.surface.registered  - POST /ui/surfaces (mount or remount)
 *   ui.surface.snapshot    - PUT  /ui/surfaces/:id/snapshot
 *   ui.surface.action      - dispatchToSurface (HTTP POST or internal call)
 *   ui.surface.acked       - POST /ui/surfaces/:id/ack
 *   ui.surface.removed     - DELETE /ui/surfaces/:id (only when actually existed)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createBusRouter, dispatchToSurface } from '../src/api/bus';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';

function freshApp(): Hono {
  const app = new Hono();
  app.route('/api/bus', createBusRouter());
  return app;
}

describe('ui.surface.* ledger replay - DUAL-MODALITY 9.8', () => {
  let app: Hono;
  beforeEach(async () => {
    _resetEventBusForTests();
    app = freshApp();
    for (const id of ['ui9.8r.a', 'ui9.8r.b']) {
      await app.request(`/api/bus/ui/surfaces/${id}`, { method: 'DELETE' });
    }
    // Reset again so the DELETE-emitted events from the cleanup aren't visible.
    _resetEventBusForTests();
  });

  it('emits ui.surface.registered on POST /ui/surfaces', async () => {
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui9.8r.a', layer: 'plugin', initialSnapshot: { v: 1 } }),
    });
    const events = getEventBus().recent('ui.surface.registered', 10);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      id: 'ui9.8r.a',
      layer: 'plugin',
      remount: false,
      hasInitialSnapshot: true,
    });
  });

  it('marks remount=true when re-registering same id', async () => {
    const body = JSON.stringify({ id: 'ui9.8r.a' });
    await app.request('/api/bus/ui/surfaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await app.request('/api/bus/ui/surfaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const events = getEventBus().recent('ui.surface.registered', 10);
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({ remount: false });
    expect(events[1].payload).toMatchObject({ remount: true });
  });

  it('emits ui.surface.snapshot on PUT /snapshot', async () => {
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui9.8r.a' }),
    });
    await app.request('/api/bus/ui/surfaces/ui9.8r.a/snapshot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: { tab: 'workbench' } }),
    });
    const events = getEventBus().recent('ui.surface.snapshot', 10);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      id: 'ui9.8r.a',
      layer: 'plugin',
      snapshot: { tab: 'workbench' },
    });
  });

  it('emits ui.surface.action on dispatchToSurface + ui.surface.acked on POST /ack', async () => {
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui9.8r.a', layer: 'host' }),
    });
    const token = dispatchToSurface('ui9.8r.a', 'select', { id: 'fox' });

    const actionEvents = getEventBus().recent('ui.surface.action', 10);
    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0].payload).toMatchObject({
      id: 'ui9.8r.a',
      layer: 'host',
      action: 'select',
      args: { id: 'fox' },
      token,
      seq: 1,
    });

    await app.request('/api/bus/ui/surfaces/ui9.8r.a/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ok: true, result: { selected: 'fox' } }),
    });
    const ackEvents = getEventBus().recent('ui.surface.acked', 10);
    expect(ackEvents).toHaveLength(1);
    expect(ackEvents[0].payload).toMatchObject({
      id: 'ui9.8r.a',
      token,
      action: 'select',
      ok: true,
      result: { selected: 'fox' },
    });
  });

  it('emits ui.surface.removed on DELETE only when surface existed', async () => {
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui9.8r.a' }),
    });
    await app.request('/api/bus/ui/surfaces/ui9.8r.a', { method: 'DELETE' });
    await app.request('/api/bus/ui/surfaces/ui9.8r.never', { method: 'DELETE' });
    const events = getEventBus().recent('ui.surface.removed', 10);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ id: 'ui9.8r.a' });
  });

  it('full session replay: register -> snapshot -> action -> ack -> remove', async () => {
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui9.8r.a', initialSnapshot: { v: 1 } }),
    });
    await app.request('/api/bus/ui/surfaces/ui9.8r.a/snapshot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: { v: 2 } }),
    });
    const token = dispatchToSurface('ui9.8r.a', 'rename', { id: 'fox', name: 'Vulpes' });
    await app.request('/api/bus/ui/surfaces/ui9.8r.a/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ok: true }),
    });
    await app.request('/api/bus/ui/surfaces/ui9.8r.a', { method: 'DELETE' });

    const all = getEventBus().recent('ui.surface.*', 50);
    const topics = all.map((e) => e.topic);
    expect(topics).toEqual([
      'ui.surface.registered',
      'ui.surface.snapshot',
      'ui.surface.action',
      'ui.surface.acked',
      'ui.surface.removed',
    ]);
  });
});
