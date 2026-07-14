/**
 * /api/bus —— interface 还期望的最小 bus 路由（wu-tian807 R2 重写已删原 src/bus,
 * 但前端 Sidebar / BuildBadge / WorkbenchMode / BusAdminPanel / lib/surface.ts 还在调）。
 *
 * 这里不是恢复完整 Bus runtime,只是把 plugin manifest 读出来 + ui/surfaces 当
 * stub 返回空,让 UI 在 R3 重写 sidebar 之前不会因为 404 把工作区清空。
 *
 * Endpoints：
 *   GET    /ui/surfaces
 *   GET    /ui/surfaces/:id
 *   GET    /ui/surfaces/:id/snapshot
 *   GET    /ui/surfaces/:id/pending
 *   POST   /ui/surfaces
 *   PUT    /ui/surfaces/:id/snapshot
 *   POST   /ui/surfaces/:id/ack
 *   DELETE /ui/surfaces/:id
 */

import { Hono } from 'hono';
import { getEventBus } from '../events/bus';

export function createBusRouter(): Hono {
  const router = new Hono();


  // ui/surfaces —— Map-backed live store. dual-modality 入口:
  //   - 插件 panel.tsx 走 POST/PUT/GET 注册自身 + 上报 snapshot + poll pending
  //   - AI tool handler (/api/wb/character/*) 走 dispatchToSurface() 在
  //     pending 队列里挂 action,等 panel 下一轮 poll 拉走 → 渲染端调 __ceInvoke
  //   两路汇合在同一个 Map<surfaceId, SurfaceRecord>,不持久化(进程重启即清)。
  //
  // DUAL-MODALITY 9.8 ledger replay - every register/snapshot/dispatch/ack/
  // delete also emits a `ui.surface.*` event onto the global EventBus ring
  // buffer. /api/events/recent?topic=ui.surface.*&n=N returns the history so
  // a chat session that boots after the player has been clicking around can
  // inject "what the player did since last time" into the AI prompt context.
  // The ring buffer is process-local (2048 slots); cross-process persistence
  // is an EventBus journal sink concern, not a bus.ts concern.

  router.get('/ui/surfaces', (c) => {
    const items = listSurfacesSlim();
    return c.json({ items });
  });

  // DUAL-MODALITY 9.8 - bulk snapshot replay. Returns the current snapshot
  // of every registered surface in one call so the chat session can inject
  // "what the player sees right now" into the AI prompt context on boot
  // (or on reconnect). Skips surfaces where snapshot===null.
  router.get('/ui/surfaces/snapshots', (c) => {
    const items: Array<{ id: string; layer: SurfaceLayer; snapshot: unknown; updatedAt: number }> = [];
    for (const rec of surfaces.values()) {
      if (rec.snapshot === null) continue;
      items.push({ id: rec.id, layer: rec.layer, snapshot: rec.snapshot, updatedAt: rec.updatedAt });
    }
    return c.json({ items, count: items.length });
  });

  router.get('/ui/surfaces/:id', (c) => {
    const rec = surfaces.get(c.req.param('id'));
    if (!rec) return c.json({ error: 'not-found', id: c.req.param('id') }, 404);
    return c.json(surfaceSlim(rec));
  });

  router.get('/ui/surfaces/:id/snapshot', (c) => {
    const rec = surfaces.get(c.req.param('id'));
    if (!rec) return c.json({ snapshot: null }, 404);
    return c.json({ snapshot: rec.snapshot });
  });

  router.get('/ui/surfaces/:id/pending', (c) => {
    const id = c.req.param('id');
    const rec = surfaces.get(id);
    if (!rec) return c.json({ actions: [] });
    // 返回所有未 ack 的 pending; 前端 panel 拉到后逐条 run + POST /ack。
    return c.json({ actions: rec.pending.slice() });
  });

  router.post('/ui/surfaces', async (c) => {
    let body: { id?: string; layer?: string; schema?: unknown; actions?: Array<{ id: string; exposedToAI?: boolean; argsSchema?: unknown }>; initialSnapshot?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    if (!body.id || typeof body.id !== 'string') return c.json({ error: 'missing-id' }, 400);
    const now = Date.now();
    const existing = surfaces.get(body.id);
    const layer = (body.layer as SurfaceLayer) ?? 'plugin';
    surfaces.set(body.id, {
      id: body.id,
      layer,
      schema: body.schema ?? null,
      actions: body.actions ?? [],
      snapshot: body.initialSnapshot ?? existing?.snapshot ?? null,
      pending: existing?.pending ?? [],
      seqCounter: existing?.seqCounter ?? 0,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });
    getEventBus().emit('ui.surface.registered', {
      id: body.id,
      layer,
      remount: existing != null,
      hasInitialSnapshot: body.initialSnapshot !== undefined,
    });
    return c.json({ ok: true });
  });

  router.put('/ui/surfaces/:id/snapshot', async (c) => {
    const id = c.req.param('id');
    let body: { snapshot?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    // Upsert: hosts (e.g. host.sidebar) may PUT a snapshot before they have
    // explicitly POST-registered the surface — the registration and the first
    // snapshot can race during React mount. Rather than 404 (which surfaces a
    // noisy console error in the UI), lazily register the surface so the
    // snapshot lands. Layer is inferred from the id prefix.
    let rec = surfaces.get(id);
    if (!rec) {
      const now = Date.now();
      const layer: SurfaceLayer = id.startsWith('host.') ? 'host' : 'plugin';
      rec = {
        id,
        layer,
        schema: null,
        actions: [],
        snapshot: null,
        pending: [],
        seqCounter: 0,
        updatedAt: now,
        createdAt: now,
      };
      surfaces.set(id, rec);
      getEventBus().emit('ui.surface.registered', {
        id,
        layer,
        remount: false,
        hasInitialSnapshot: false,
      });
    }
    rec.snapshot = body.snapshot ?? null;
    rec.updatedAt = Date.now();
    getEventBus().emit('ui.surface.snapshot', {
      id,
      layer: rec.layer,
      snapshot: rec.snapshot,
    });
    return c.json({ ok: true });
  });

  router.post('/ui/surfaces/:id/ack', async (c) => {
    const id = c.req.param('id');
    const rec = surfaces.get(id);
    if (!rec) return c.json({ error: 'not-found' }, 404);
    let body: { token?: string; ok?: boolean; error?: string; result?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const idx = rec.pending.findIndex((p) => p.token === body.token);
    if (idx >= 0) {
      const [removed] = rec.pending.splice(idx, 1);
      const waiter = ackWaiters.get(removed.token);
      if (waiter) {
        waiter.resolve({ ok: body.ok !== false, error: body.error, result: body.result });
        ackWaiters.delete(removed.token);
      }
      getEventBus().emit('ui.surface.acked', {
        id,
        token: removed.token,
        action: removed.action,
        ok: body.ok !== false,
        error: body.error,
        result: body.result,
      });
    }
    return c.json({ ok: true });
  });

  // 新增 endpoint: AI 通过 HTTP 派发动作到 surface (服务端内部也可用 dispatchToSurface 直调)
  router.post('/ui/surfaces/:id/dispatch', async (c) => {
    const id = c.req.param('id');
    let body: { action?: string; args?: unknown; awaitAck?: boolean; timeoutMs?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    if (!body.action) return c.json({ error: 'missing-action' }, 400);
    try {
      if (body.awaitAck) {
        const r = await dispatchAndWait(id, body.action, body.args, body.timeoutMs ?? 10000);
        return c.json(r);
      }
      const token = dispatchToSurface(id, body.action, body.args);
      return c.json({ ok: true, token });
    } catch (e) {
      return c.json({ error: 'dispatch-failed', message: (e as Error).message }, 400);
    }
  });

  router.delete('/ui/surfaces/:id', (c) => {
    const id = c.req.param('id');
    const existed = surfaces.delete(id);
    if (existed) getEventBus().emit('ui.surface.removed', { id });
    return c.json({ ok: true });
  });

  return router;
}

// ───────────────────────── Surfaces in-memory store ─────────────────────────
//
// Surface 是一份「UI 状态 + 可触发动作集合」的注册项. panel.tsx 在 mount 时
// 调 POST /ui/surfaces 注册,自己维护 snapshot+actions. AI 想驱动 UI 时调
// dispatchToSurface() 往 pending 队列加一条; panel poll 拉走 → run → ack.

type SurfaceLayer = 'host' | 'plugin' | 'iframe';

interface SurfaceActionDef {
  id: string;
  exposedToAI?: boolean;
  argsSchema?: unknown;
}

interface PendingAction {
  seq: number;
  token: string;
  action: string;
  args: unknown;
  ts: number;
}

interface SurfaceRecord {
  id: string;
  layer: SurfaceLayer;
  schema: unknown;
  actions: SurfaceActionDef[];
  snapshot: unknown;
  pending: PendingAction[];
  seqCounter: number;
  createdAt: number;
  updatedAt: number;
}

interface SurfaceSlim {
  id: string;
  layer: SurfaceLayer;
  actions: SurfaceActionDef[];
  hasSnapshot: boolean;
  pendingCount: number;
  updatedAt: number;
}

const surfaces = new Map<string, SurfaceRecord>();
const ackWaiters = new Map<string, { resolve: (v: { ok: boolean; error?: string; result?: unknown }) => void }>();

function surfaceSlim(rec: SurfaceRecord): SurfaceSlim {
  return {
    id: rec.id,
    layer: rec.layer,
    actions: rec.actions,
    hasSnapshot: rec.snapshot !== null,
    pendingCount: rec.pending.length,
    updatedAt: rec.updatedAt,
  };
}

function listSurfacesSlim(): SurfaceSlim[] {
  return [...surfaces.values()].map(surfaceSlim);
}

/**
 * Enqueue an action for `surfaceId`. Returns the token panel will ack with.
 * Throws if the surface isn't registered yet — caller decides whether to
 * surface that to AI or buffer and retry. Used by /api/wb/character/* tool
 * handlers AND by the HTTP POST /ui/surfaces/:id/dispatch endpoint.
 */
export function dispatchToSurface(surfaceId: string, action: string, args: unknown): string {
  const rec = surfaces.get(surfaceId);
  if (!rec) throw new Error(`surface ${surfaceId} not registered`);
  rec.seqCounter += 1;
  const token = `${surfaceId}-${rec.seqCounter}-${Math.random().toString(36).slice(2, 8)}`;
  rec.pending.push({ seq: rec.seqCounter, token, action, args, ts: Date.now() });
  rec.updatedAt = Date.now();
  getEventBus().emit('ui.surface.action', {
    id: surfaceId,
    layer: rec.layer,
    action,
    args,
    token,
    seq: rec.seqCounter,
  });
  return token;
}

/**
 * Same as dispatchToSurface() but blocks until panel acks (or timeout). Useful
 * when AI tool handler wants the panel's result before returning to forgeax-cli.
 * If panel never acks, resolves to {ok:false, error:'timeout'} after timeoutMs.
 */
export function dispatchAndWait(
  surfaceId: string,
  action: string,
  args: unknown,
  timeoutMs = 10000,
): Promise<{ ok: boolean; error?: string; result?: unknown; timedOut?: boolean }> {
  const token = dispatchToSurface(surfaceId, action, args);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(token);
      // Best-effort: drop the pending entry too so the panel doesn't run a stale one
      const rec = surfaces.get(surfaceId);
      if (rec) {
        const idx = rec.pending.findIndex((p) => p.token === token);
        if (idx >= 0) rec.pending.splice(idx, 1);
      }
      resolve({ ok: false, error: 'timeout', timedOut: true });
    }, timeoutMs);
    ackWaiters.set(token, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
    });
  });
}

/** For testing / diagnostics: returns the snapshot if the surface exists. */
export function getSurfaceSnapshot(surfaceId: string): unknown {
  return surfaces.get(surfaceId)?.snapshot ?? null;
}
