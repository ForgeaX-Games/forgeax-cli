/** Ledger replay —— merge every per-agent `events-*.jsonl` shard plus the
 *  per-session `global-events.jsonl` into one timestamp-sorted stream of
 *  `StoredEvent`. The Observatory `/api/observatory/events` SSE route
 *  drains this once at connect, then switches to live `eventBus.observe`.
 *
 *  Why both: agent ledgers carry the conversational WAL (turn / tool /
 *  assistantMessage), while global-events.jsonl carries session-level
 *  broadcasts (agent_added, partial_boundary, …) that the observatory
 *  needs to draw sub-agent nodes and context_update bars.
 *
 *  Usage is intentionally one-shot — caller awaits the array and writes
 *  it out as SSE frames. The full ledger of a long session is a few MB
 *  at most; Bun handles that comfortably without backpressure tricks.
 */

import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { EventLedger } from '../ledger/event-ledger';
import { parseEvents } from '../ledger/event-store';
import type { StoredEvent } from '../ledger/types';
import type { PathManagerAPI } from '../fs/types';

/** Walk `<sid>/agents/**` (套娃 — children live under `<dir>/agents/`),
 *  return every agent-path discovered. Mirrors AgentTree.list() but does
 *  not require an open Session — useful for replaying closed sessions. */
function listAgentPaths(agentsRoot: string): string[] {
  if (!existsSync(agentsRoot)) return [];
  const out: string[] = [];
  const walk = (curDir: string) => {
    let entries: string[];
    try { entries = readdirSync(curDir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const abs = join(curDir, name);
      let stat;
      try { stat = lstatSync(abs); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const rel = relative(agentsRoot, abs).split(sep).join('/');
      out.push(rel);
      const child = join(abs, 'agents');
      if (existsSync(child)) walk(child);
    }
  };
  walk(agentsRoot);
  return out;
}

/** Read the session's global-events.jsonl (same shape as ledger StoredEvent
 *  minus the blob pointer machinery — system-event-log writes plain JSONL). */
async function readGlobalEvents(sessionRoot: string): Promise<StoredEvent[]> {
  const file = join(sessionRoot, 'global-events.jsonl');
  if (!existsSync(file)) return [];
  let raw: string;
  try { raw = await readFile(file, 'utf-8'); } catch { return []; }
  return parseEvents(raw);
}

/** Replay every persisted event for one session, ordered by `ts` ascending.
 *  agent ledger blobs are hydrated via EventLedger.readAllEvents(); global
 *  events arrive as plain JSONL. */
export async function replaySessionEvents(
  sid: string,
  paths: PathManagerAPI,
): Promise<StoredEvent[]> {
  const layer = paths.session(sid);
  const sessionRoot = layer.root();
  if (!existsSync(sessionRoot)) return [];

  const all: StoredEvent[] = [];

  for (const agentPath of listAgentPaths(layer.agentsDir())) {
    const ledger = new EventLedger(sid, agentPath, paths);
    try {
      const events = await ledger.readAllEvents();
      all.push(...events);
    } catch (err) {
      process.stderr.write(`[observatory:replay] ${sid}/${agentPath}: ${(err as Error).message}\n`);
    }
  }

  all.push(...await readGlobalEvents(sessionRoot));

  all.sort((a, b) => a.ts - b.ts);
  return all;
}
