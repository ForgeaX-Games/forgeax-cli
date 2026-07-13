/** /api/observatory — backing API for the wb-observatory workbench plugin.
 *
 *  Four endpoints, all read-only:
 *    GET /sessions                           — `[{sid, displayName, defaultDir}]`
 *    GET /sessions/:sid/agents               — `[{path, display, depth, parent}]`
 *    GET /inspect?session=X&agent=Y          — composed system prompt, sliced
 *    GET /events?session=X                   — SSE: ledger replay → live tail
 *
 *  The frontend's `?session=current` shorthand is handled here by picking the
 *  most-recently-opened session (in-memory map first, falling back to disk
 *  mtime). All four routes are passive — they never mutate session state.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSessionManager } from '../core/session-manager';
import { getPathManager } from '../fs/path-manager';
import { adapt, createAdapterState, makeInitEvent } from '../observatory/event-adapter';
import { inspectAgentPrompt } from '../observatory/prompt-modules';
import { replaySessionEvents } from '../observatory/ledger-replay';
import { replaySessionTelemetry, tailSessionTelemetry } from '../observatory/telemetry-replay';
import type { TelemetryRecord } from '@forgeax/types';
import type { Event } from '../core/types';

interface SessionEntry {
  /** Canonical session id (UUID). Surfaced to the frontend as `id`. */
  id: string;
  displayName?: string;
  defaultDir?: string;
  /** mtime in ms — frontend renders relative; missing if statSync failed. */
  updated?: number;
  /** Created from sessions.dir mtime fallback when ctimeMs is unreliable. */
  created?: number;
}

function newestMtimeUnder(dir: string): number {
  let best = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && st.mtimeMs > best) best = st.mtimeMs;
        if (st.isDirectory()) {
          const sub = newestMtimeUnder(full);
          if (sub > best) best = sub;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir unreadable */ }
  return best;
}

function listSessionsWithMtime(): SessionEntry[] {
  const sm = getSessionManager();
  const pm = getPathManager();
  const out: SessionEntry[] = [];
  // Derive, don't duplicate: sm.list() already computes lastActivityAt (newest
  // mtime under agents/, falling back to the session dir mtime) with caching.
  // The old copy here re-walked every session's agents tree AND re-resolved
  // every sid through the layout — doubling the /api/sessions disk cost on a
  // hot, event-loop-blocking path.
  for (const entry of sm.list()) {
    let created: number | undefined;
    try {
      created = statSync(pm.session(entry.sid).root()).ctimeMs;
    } catch { /* ignore */ }
    out.push({
      id: entry.sid,
      displayName: entry.displayName,
      defaultDir: entry.defaultDir,
      updated: entry.lastActivityAt,
      created,
    });
  }
  out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return out;
}

/** Resolve "current" → the most-recently-touched session sid. Returns null
 *  when there are no sessions on disk at all. */
function resolveSid(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (raw !== 'current') return raw;
  const sessions = listSessionsWithMtime();
  return sessions[0]?.id ?? null;
}

export function createObservatoryRouter() {
  const r = new Hono();
  const pm = getPathManager();

  r.get('/sessions', (c) => {
    // Flat array; frontend's useSessionList expects `[{id, displayName?, defaultDir?, updated?, created?}]`.
    return c.json(listSessionsWithMtime());
  });

  r.get('/sessions/:sid/agents', async (c) => {
    const sid = resolveSid(c.req.param('sid'));
    if (!sid) return c.json({ error: 'no sessions' }, 404);

    const sm = getSessionManager();
    let session;
    try { session = await sm.open(sid); }
    catch { return c.json({ error: `session not found: ${sid}` }, 404); }

    const nodes = session.tree.list().map((n) => ({
      path: n.path,
      display: n.display,
      depth: n.depth,
      parent: n.parent ?? null,
      fullId: n.fullId,
    }));
    return c.json({ sid, agents: nodes });
  });

  r.get('/inspect', async (c) => {
    const sid = resolveSid(c.req.query('session') ?? 'current');
    const agentParam = c.req.query('agent');
    if (!sid) return c.json({ error: 'no sessions available' }, 404);

    const sm = getSessionManager();
    let session;
    try { session = await sm.open(sid); }
    catch { return c.json({ error: `session not found: ${sid}` }, 404); }

    // The observatory "agent" param is an agent-tree path like "iori" or
    // "iori/suzu". Resolve the corresponding agent.json::id (the registry
    // id, eg "forge", "iori") so composeSystemPrompt finds it.
    // When the param is missing the panel asks for "the session's prompt"
    // — fall back to the root agent (depth 1).
    const node = agentParam
      ? session.tree.get(agentParam)
      : session.tree.list().find((n) => n.depth === 1);
    if (!node) return c.json({ error: `agent path not found: ${agentParam ?? '(root)'}` }, 404);

    const agentJsonPath = pm.session(sid).agent(node.path).agentJson();
    let agentId = node.display;
    if (existsSync(agentJsonPath)) {
      try {
        const cfg = JSON.parse(await readFile(agentJsonPath, 'utf8')) as { id?: string };
        if (typeof cfg.id === 'string' && cfg.id) agentId = cfg.id;
      } catch { /* fall through with display name */ }
    }

    // Active-game scope = session.config.defaultDir (preferred — explicit
    // operator choice) → fall back to the workspace's most-recently-touched
    // game so the slice still surfaces the `active_game` trailer when the
    // session has no slug pinned but a game obviously exists.
    const sessionSlug = (session.config as { defaultDir?: string } | undefined)?.defaultDir;
    const activeSlug = (sessionSlug && sessionSlug.trim())
      ? sessionSlug
      : getPathManager().resolveScope() ?? undefined;

    // Native agents (running in-process via ConsciousAgent/scheduler) assemble
    // their prompt via ContextEngine slots — they never see the FORGEAX_SYSTEM_PROMPT
    // scaffold. Only claude-code CLI provider injects that scaffold via
    // --append-system-prompt. Detect by checking if the scheduler owns this agent.
    const runningAgent = session.scheduler.getAgent(node.path);
    const isNativeAgent = !!runningAgent;
    const inspection = await inspectAgentPrompt(agentId, {
      activeSlug,
      includeForgeaxScaffold: !isNativeAgent,
    });
    if (!inspection) return c.json({ error: `agent id unresolved: ${agentId}` }, 404);

    // Collect tool definitions from the running agent's registry.
    // Each tool's name + description + input_schema is part of the LLM payload
    // (Anthropic `tools` field) and contributes to context usage.
    let toolModules: typeof inspection.modules = [];
    if (runningAgent) {
      const tools = runningAgent.agentContext.tools.list();
      if (tools.length > 0) {
        const APPROX_CHARS_PER_TOKEN = 4;
        const toolsBody = tools.map(t => {
          const schema = JSON.stringify(t.input_schema, null, 2);
          return `### ${t.name}\n\n${t.description}${t.guidance ? `\n\n**Guidance:** ${t.guidance}` : ''}\n\n\`\`\`json\n${schema}\n\`\`\``;
        }).join('\n\n');
        const totalChars = toolsBody.length;
        const promptTotalChars = inspection.charCount + totalChars;
        toolModules = [{
          id: 'tools',
          tag: `tools (${tools.length})`,
          content: toolsBody,
          charCount: totalChars,
          estimatedTokens: Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN),
          percentOfTotal: promptTotalChars > 0 ? +(totalChars / promptTotalChars * 100).toFixed(2) : 0,
          children: tools.map((t, i) => {
            const body = `${t.description}${t.guidance ? `\n\nGuidance: ${t.guidance}` : ''}\n\n${JSON.stringify(t.input_schema, null, 2)}`;
            const cc = body.length;
            return {
              id: `tools#${i}`,
              tag: t.name,
              content: body,
              charCount: cc,
              estimatedTokens: Math.ceil(cc / APPROX_CHARS_PER_TOKEN),
              percentOfTotal: promptTotalChars > 0 ? +(cc / promptTotalChars * 100).toFixed(2) : 0,
            };
          }),
        }];
      }
    }

    return c.json({
      sid,
      agentPath: node.path,
      agentId,
      activeSlug,
      systemPrompt: {
        ...inspection,
        modules: [...toolModules, ...inspection.modules],
        charCount: inspection.charCount + toolModules.reduce((s, m) => s + m.charCount, 0),
        estimatedTokens: inspection.estimatedTokens + toolModules.reduce((s, m) => s + m.estimatedTokens, 0),
      },
      // Static telemetry snapshot for whole-graph colouring (todo 038 P1): the
      // same full replay the /telemetry SSE streams, embedded so a one-shot
      // inspect can paint span/log overlays without opening the stream.
      telemetry: await replaySessionTelemetry(sid),
    });
  });

  r.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // Frontend's `current` shorthand sends an empty `?session=` (or none
      // at all) — both resolve to the most-recently-touched sid.
      const sid = resolveSid(c.req.query('session') ?? 'current');
      if (!sid) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'no sessions available' }) });
        return;
      }

      // Try to open the session for live tailing. Replay still works even if
      // open fails (closed session, manifest missing) — we just skip the live
      // observer hookup in that case.
      const sm = getSessionManager();
      let session;
      try { session = await sm.open(sid); } catch { session = null; }

      const state = createAdapterState();

      // Synthetic system/init so the reactflow root node always renders.
      // Prefer "forge" if it exists; otherwise first depth-1 agent.
      const rootAgent = (() => {
        if (!session) return 'forge';
        const list = session.tree.list();
        const forge = list.find((n) => n.depth === 1 && n.display === 'forge');
        if (forge) return forge.display;
        const root = list.find((n) => n.depth === 1);
        return root?.display ?? 'forge';
      })();
      const init = makeInitEvent(rootAgent);
      await stream.writeSSE({ data: JSON.stringify({ sessionId: sid, event: init, ts: Date.now() }) });

      // Replay phase — drain ledger + global-events.jsonl. `sentCount` marks how
      // many ordered events we've emitted; the live phase emits only the tail past it.
      let sentCount = 0;
      try {
        const replayed = await replaySessionEvents(sid, pm);
        for (const stored of replayed) {
          for (const ev of adapt(stored, state)) {
            await stream.writeSSE({ data: JSON.stringify({ sessionId: sid, event: ev, ts: stored.ts }) });
          }
        }
        sentCount = replayed.length;
      } catch (err) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: (err as Error).message }) });
      }

      // Live phase — tail the LEDGER, not the in-process eventBus (todo 042).
      // forgeax-core records its turn/tool/ask events by writing the ledger
      // directly (transcribe-turn.ts, deliberately NOT via eventBus to avoid WS
      // double-render), so an eventBus observer never sees them → nodes stuck
      // "running" and later events never arrive live. Instead we re-replay the
      // ledger whenever it changes on disk (mtime-gated) and emit only the new
      // tail. This reuses replaySessionEvents' blob hydration + multi-agent shard
      // walk and works uniformly for EVERY kernel (all persist to the ledger).
      const sessionRoot = pm.session(sid).root();
      let lastMtime = 0;
      try { lastMtime = newestMtimeUnder(sessionRoot); } catch { /* ignore */ }
      let aborted = false;
      stream.onAbort(() => { aborted = true; });

      const POLL_MS = 1500;
      let sinceHeartbeatMs = 0;
      while (!aborted) {
        await stream.sleep(POLL_MS);
        if (aborted) break;

        // Only re-read the ledger when something under the session changed.
        let mtime = lastMtime;
        try { mtime = newestMtimeUnder(sessionRoot); } catch { /* ignore */ }
        if (mtime > lastMtime) {
          lastMtime = mtime;
          try {
            const all = await replaySessionEvents(sid, pm);
            for (let i = sentCount; i < all.length; i++) {
              const stored = all[i]!;
              for (const ev of adapt(stored, state)) {
                await stream.writeSSE({ data: JSON.stringify({ sessionId: sid, event: ev, ts: stored.ts }) });
              }
            }
            if (all.length > sentCount) sentCount = all.length;
          } catch { /* transient read error — retry next tick */ }
        }

        // Heartbeat (~15s) so reverse proxies don't kill the idle SSE connection.
        sinceHeartbeatMs += POLL_MS;
        if (sinceHeartbeatMs >= 15_000) {
          sinceHeartbeatMs = 0;
          await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
        }
      }
    }),
  );

  // Telemetry plane (todo 038 P1) — trace/log SSE paralleling /events, but the
  // source is the on-disk `<sid>/logs/{trace,log}.jsonl` (replay) + fs.watch
  // tail (live), NOT the in-process eventBus: forgeax-core telemetry reaches
  // disk via RPC→sink, never the bus. Each frame carries one TelemetryRecord.
  // Pure addition — any error here never touches /events or the trajectory plane.
  r.get('/telemetry', (c) =>
    streamSSE(c, async (stream) => {
      const sid = resolveSid(c.req.query('session') ?? 'current');
      if (!sid) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'no sessions available' }) });
        return;
      }

      // Replay phase — full backlog, dedup provisional→final, sorted ascending.
      try {
        const records = await replaySessionTelemetry(sid);
        for (const record of records) {
          await stream.writeSSE({ data: JSON.stringify({ sessionId: sid, record }) });
        }
      } catch (err) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: (err as Error).message }) });
      }

      // Live phase — fs.watch tail of the two jsonl files until disconnect.
      const queue: TelemetryRecord[] = [];
      let writing = false;
      const flush = async () => {
        if (writing) return;
        writing = true;
        while (queue.length > 0) {
          const record = queue.shift()!;
          await stream.writeSSE({ data: JSON.stringify({ sessionId: sid, record }) });
        }
        writing = false;
      };
      const unsub = tailSessionTelemetry(sid, (rec) => { queue.push(rec); void flush(); });
      let aborted = false;
      stream.onAbort(() => { aborted = true; unsub(); });

      // Heartbeat so reverse proxies don't kill idle SSE connections. Abort-gated
      // (same as /events): `stream.sleep` never rejects on disconnect and writeSSE
      // swallows write errors, so a bare `while (true)` would spin forever after
      // the client drops — leaking the async frame + a rescheduled 15s timer per
      // dead connection. The gate lets the loop fall through to stream.close().
      while (!aborted) {
        await stream.sleep(15_000);
        if (aborted) break;
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
    }),
  );

  return r;
}
