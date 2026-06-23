/** /api/usage —— Phase C7 用量 dashboard 数据源。
 *
 *  扫 `<userRoot>/sessions/<sid>/agents/<agentPath>/events/events-*.jsonl`，
 *  挑出 `hook:assistantMessage` 事件（这是 LLM gateway 当前唯一会落 usage 的事件），
 *  按 model / sid / day 三个维度聚合 inputTokens + outputTokens + 调用次数。
 *
 *  端点：
 *  - GET  /api/usage                   → 全量聚合
 *  - GET  /api/usage?sid=<sid>         → 限定 session
 *  - GET  /api/usage?since=<unix-ms>   → 限定时间下界
 *
 *  返回：
 *    { totals: { calls, inputTokens, outputTokens },
 *      byModel: [{ model, calls, inputTokens, outputTokens }],
 *      bySession: [{ sid, calls, inputTokens, outputTokens }],
 *      byDay: [{ day: 'YYYY-MM-DD', calls, inputTokens, outputTokens }],
 *      sourcedFrom: { sessionsScanned, eventsScanned } }
 *
 *  用量事件捕捉规则：line 必须含 `type=hook:assistantMessage` 且 `payload.usage.{inputTokens,outputTokens}`
 *  皆为 number；payload.model 缺失时记作 'unknown'。 */

import { Hono } from 'hono';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPathManager } from '../fs/path-manager';

interface UsageRow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageReport {
  totals: UsageRow;
  byModel: Array<UsageRow & { model: string }>;
  bySession: Array<UsageRow & { sid: string }>;
  byDay: Array<UsageRow & { day: string }>;
  sourcedFrom: { sessionsScanned: number; eventsScanned: number };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function bump(row: UsageRow, input: number, output: number): void {
  row.calls += 1;
  row.inputTokens += input;
  row.outputTokens += output;
}

async function readDirEntries(p: string): Promise<Dirent[]> {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
}

/** Recursive walk: yields every events-*.jsonl path under an agent dir tree.
 *  Sub-agents nest as `<agentDir>/agents/<sub>/events/...` so we recurse.
 *  Uses readdir({withFileTypes}) so we get type info without a per-entry stat. */
async function* walkAgentEventFiles(agentDir: string): AsyncGenerator<string> {
  const eventsDir = join(agentDir, 'events');
  for (const ent of await readDirEntries(eventsDir)) {
    if (ent.isFile() && ent.name.startsWith('events-') && ent.name.endsWith('.jsonl')) {
      yield join(eventsDir, ent.name);
    }
  }
  const subAgents = join(agentDir, 'agents');
  for (const ent of await readDirEntries(subAgents)) {
    if (ent.isDirectory()) yield* walkAgentEventFiles(join(subAgents, ent.name));
  }
}

export async function aggregateUsage(opts: {
  sessionsDir: string;
  sid?: string;
  since?: number;
}): Promise<UsageReport> {
  const totals: UsageRow = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const byModel = new Map<string, UsageRow>();
  const bySession = new Map<string, UsageRow>();
  const byDay = new Map<string, UsageRow>();
  let sessionsScanned = 0;
  let eventsScanned = 0;

  const sids = opts.sid
    ? [opts.sid]
    : (await readDirEntries(opts.sessionsDir)).map((e) => e.name);
  for (const sid of sids) {
    const agentsDir = join(opts.sessionsDir, sid, 'agents');
    let agentTops: Dirent[];
    try { agentTops = await readdir(agentsDir, { withFileTypes: true }); } catch { continue; }
    sessionsScanned += 1;
    for (const top of agentTops) {
      if (!top.isDirectory()) continue;
      const topDir = join(agentsDir, top.name);
      for await (const file of walkAgentEventFiles(topDir)) {
        let raw: string;
        try { raw = await readFile(file, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          eventsScanned += 1;
          let ev: any;
          try { ev = JSON.parse(trimmed); } catch { continue; }
          if (ev?.type !== 'hook:assistantMessage') continue;
          const usage = ev?.payload?.usage;
          if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') continue;
          const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
          if (typeof opts.since === 'number' && ts < opts.since) continue;
          const model = typeof ev?.payload?.model === 'string' ? ev.payload.model : 'unknown';

          bump(totals, usage.inputTokens, usage.outputTokens);

          let mRow = byModel.get(model);
          if (!mRow) { mRow = { calls: 0, inputTokens: 0, outputTokens: 0 }; byModel.set(model, mRow); }
          bump(mRow, usage.inputTokens, usage.outputTokens);

          let sRow = bySession.get(sid);
          if (!sRow) { sRow = { calls: 0, inputTokens: 0, outputTokens: 0 }; bySession.set(sid, sRow); }
          bump(sRow, usage.inputTokens, usage.outputTokens);

          const day = dayKey(ts);
          let dRow = byDay.get(day);
          if (!dRow) { dRow = { calls: 0, inputTokens: 0, outputTokens: 0 }; byDay.set(day, dRow); }
          bump(dRow, usage.inputTokens, usage.outputTokens);
        }
      }
    }
  }

  return {
    totals,
    byModel: [...byModel.entries()]
      .map(([model, r]) => ({ model, ...r }))
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    bySession: [...bySession.entries()]
      .map(([sid, r]) => ({ sid, ...r }))
      .sort((a, b) => b.calls - a.calls),
    byDay: [...byDay.entries()]
      .map(([day, r]) => ({ day, ...r }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    sourcedFrom: { sessionsScanned, eventsScanned },
  };
}

export function createUsageRouter() {
  const r = new Hono();
  r.get('/', async (c) => {
    const sid = c.req.query('sid') || undefined;
    const sinceRaw = c.req.query('since');
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const sessionsDir = getPathManager().user().sessionsDir();
    const report = await aggregateUsage({ sessionsDir, sid, since: Number.isFinite(since) ? since : undefined });
    return c.json(report);
  });
  return r;
}
