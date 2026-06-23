/**
 * /api/threads —— interface 还期望的最小 threads 路由（wu-tian807 R2 重写已删
 * 原 ChatHistory / Thread runtime,但前端 store.ts / AgentsPanel / Dashboard /
 * dashboard-api.ts 还在调）。
 *
 * Endpoints：
 *   GET    /                         { threads: [] }
 *   GET    /:id                      404 { error }
 *   PATCH  /:id                      { ok: true }
 *   GET    /:id/used-agents          { threadId, activeEmitterId, agents: [] }
 *                                    ↳ derived from session.tree.list() +
 *                                      file-activity.jsonl writers, so
 *                                      AgentsPanel session-scoped filter
 *                                      surfaces sub-agents that the
 *                                      orchestrator has spawned/used.
 *   DELETE /:id                      { ok: true }
 */

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { getSessionManager } from '../core/session-manager';
import { findMarketplaceManifest } from './lib/marketplace-manifest';
import { defaultProjectRoot } from './lib/safe-path';

/** Read marketplace manifest once per request to identify the orchestrator
 *  (`default: true`). Tree-depth alone can't tell us — `delegate_to_subagent`
 *  attaches sub-agents as siblings of the root, so every node lands at
 *  depth 1. Returns the set of orchestrator ids; usually a single name. */
function readMainAgentIds(): Set<string> {
  const out = new Set<string>();
  try {
    const found = findMarketplaceManifest(defaultProjectRoot());
    if (!found.path) return out;
    const raw = readFileSync(found.path, 'utf-8');
    const manifest = JSON.parse(raw) as { agents?: Array<{ id: string; default?: boolean }> };
    for (const a of manifest.agents ?? []) {
      if (a.default && a.id) out.add(a.id);
    }
  } catch { /* ignore — fall back to no main marker */ }
  return out;
}

export function createThreadsRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    return c.json({ threads: [] });
  });

  router.get('/:id', (c) => {
    return c.json({ error: 'not-found', id: c.req.param('id') }, 404);
  });

  router.patch('/:id', async (c) => {
    // accept { activeEmitterId } but no-op until R3 re-introduces thread state.
    try { await c.req.json(); } catch { /* tolerate empty body */ }
    return c.json({ ok: true });
  });

  router.get('/:id/used-agents', (c) => {
    const tid = c.req.param('id');
    const session = getSessionManager().peek(tid);
    if (!session) {
      return c.json({ threadId: tid, activeEmitterId: 'forge', agents: [] });
    }
    // Two sources, unioned:
    //   (a) session.tree.list() — all currently-attached agents (orchestrator
    //       + every sub-agent ensureAgentScaffold+attach has been called for,
    //       even if it hasn't written anything yet).
    //   (b) file-activity ledger — historical writers (covers agents that
    //       have since been detached, and gives us firstSeenAt/lastSeenAt).
    // AgentsPanel keys agents by marketplace id (`forge`, `suzu`, …). The
    // tree path's last segment is the canonical agent id — same convention
    // workbench.ts already uses for ledger bucketing.
    type Row = { id: string; role: 'main' | 'sub'; firstSeenAt: number; lastSeenAt: number; runCount: number };
    const byId = new Map<string, Row>();
    const mainIds = readMainAgentIds();

    for (const node of session.tree.list()) {
      const id = node.display;
      if (!id) continue;
      byId.set(id, {
        id,
        role: mainIds.has(id) ? 'main' : 'sub',
        firstSeenAt: 0,
        lastSeenAt: 0,
        runCount: 0,
      });
    }

    try {
      const records = session.fileActivity.query({ limit: 5000 });
      for (const r of records) {
        const id = r.agentPath.split('/').pop();
        if (!id) continue;
        const cur = byId.get(id);
        if (cur) {
          if (cur.firstSeenAt === 0 || r.ts < cur.firstSeenAt) cur.firstSeenAt = r.ts;
          if (r.ts > cur.lastSeenAt) cur.lastSeenAt = r.ts;
          cur.runCount++;
        } else {
          // ledger has writes from an agent the tree no longer carries
          // (detached / not yet re-attached after restart) — surface anyway.
          byId.set(id, {
            id,
            role: mainIds.has(id) ? 'main' : 'sub',
            firstSeenAt: r.ts,
            lastSeenAt: r.ts,
            runCount: 1,
          });
        }
      }
    } catch { /* ignore — tree-only fallback */ }

    const agents: Row[] = Array.from(byId.values()).sort((a, b) => {
      if (a.role !== b.role) return a.role === 'main' ? -1 : 1;
      return a.firstSeenAt - b.firstSeenAt;
    });
    const main = agents.find((a) => a.role === 'main');
    return c.json({
      threadId: tid,
      activeEmitterId: main?.id ?? 'forge',
      agents,
    });
  });

  router.delete('/:id', (c) => {
    return c.json({ ok: true });
  });

  return router;
}
