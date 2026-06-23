/** Phase C7 — /api/usage aggregation tests. Lays out a fake sessions tree and
 *  exercises model/session/day grouping + filters. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateUsage } from '../src/api/usage';

const TMP = `/tmp/forgeax-usage-${process.pid}`;
const SESSIONS = join(TMP, 'sessions');

function writeEvents(sid: string, agentPath: string, lines: any[]) {
  const dir = join(SESSIONS, sid, 'agents', agentPath, 'events');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'events-1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

const T0 = Date.UTC(2026, 4, 22, 10, 0, 0); // 2026-05-22 10:00 UTC
const T1 = Date.UTC(2026, 4, 23, 10, 0, 0); // 2026-05-23 10:00 UTC

function asstMsg(model: string, input: number, output: number, ts: number) {
  return {
    type: 'hook:assistantMessage',
    ts,
    payload: { model, usage: { inputTokens: input, outputTokens: output } },
  };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(SESSIONS, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('aggregateUsage', async () => {
  it('returns zeroed report when sessions dir is missing', async () => {
    const r = await aggregateUsage({ sessionsDir: join(TMP, 'nope') });
    expect(r.totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
    expect(r.byModel).toEqual([]);
    expect(r.sourcedFrom.sessionsScanned).toBe(0);
  });

  it('aggregates by model / session / day across multiple sessions', async () => {
    writeEvents('s1', 'root', [
      asstMsg('claude-opus', 100, 20, T0),
      asstMsg('claude-opus', 50, 10, T1),
      asstMsg('gpt-4o', 30, 5, T1),
    ]);
    writeEvents('s2', 'root', [
      asstMsg('claude-opus', 200, 40, T0),
    ]);

    const r = await aggregateUsage({ sessionsDir: SESSIONS });

    expect(r.totals).toEqual({ calls: 4, inputTokens: 380, outputTokens: 75 });
    expect(r.sourcedFrom.sessionsScanned).toBe(2);

    const opus = r.byModel.find((m) => m.model === 'claude-opus');
    expect(opus).toEqual({ model: 'claude-opus', calls: 3, inputTokens: 350, outputTokens: 70 });
    const gpt = r.byModel.find((m) => m.model === 'gpt-4o');
    expect(gpt).toEqual({ model: 'gpt-4o', calls: 1, inputTokens: 30, outputTokens: 5 });

    expect(r.bySession.find((s) => s.sid === 's1')!.calls).toBe(3);
    expect(r.bySession.find((s) => s.sid === 's2')!.calls).toBe(1);

    expect(r.byDay.map((d) => d.day)).toEqual(['2026-05-22', '2026-05-23']);
    expect(r.byDay[0].calls).toBe(2);
    expect(r.byDay[1].calls).toBe(2);
  });

  it('skips non-assistant events and malformed lines', async () => {
    const dir = join(SESSIONS, 's1', 'agents', 'root', 'events');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events-1.jsonl'),
      [
        JSON.stringify({ type: 'user_input', ts: T0, payload: { content: 'hi' } }),
        '{ not json',
        '',
        JSON.stringify(asstMsg('claude-opus', 10, 2, T0)),
        JSON.stringify({ type: 'hook:assistantMessage', ts: T0, payload: {} }),
      ].join('\n'),
    );
    const r = await aggregateUsage({ sessionsDir: SESSIONS });
    expect(r.totals.calls).toBe(1);
    expect(r.totals.inputTokens).toBe(10);
  });

  it('filters by sid', async () => {
    writeEvents('keep', 'root', [asstMsg('m', 1, 1, T0)]);
    writeEvents('drop', 'root', [asstMsg('m', 99, 99, T0)]);
    const r = await aggregateUsage({ sessionsDir: SESSIONS, sid: 'keep' });
    expect(r.totals).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1 });
    expect(r.bySession.map((s) => s.sid)).toEqual(['keep']);
  });

  it('filters by since', async () => {
    writeEvents('s1', 'root', [
      asstMsg('m', 1, 1, T0),
      asstMsg('m', 2, 2, T1),
    ]);
    const r = await aggregateUsage({ sessionsDir: SESSIONS, since: T1 });
    expect(r.totals).toEqual({ calls: 1, inputTokens: 2, outputTokens: 2 });
  });

  it('walks nested sub-agents', async () => {
    writeEvents('s1', 'root', [asstMsg('m', 1, 1, T0)]);
    writeEvents('s1', 'root/agents/child', [asstMsg('m', 5, 5, T0)]);
    const r = await aggregateUsage({ sessionsDir: SESSIONS });
    expect(r.totals).toEqual({ calls: 2, inputTokens: 6, outputTokens: 6 });
  });

  it('treats missing model as "unknown"', async () => {
    const dir = join(SESSIONS, 's1', 'agents', 'root', 'events');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events-1.jsonl'),
      JSON.stringify({
        type: 'hook:assistantMessage',
        ts: T0,
        payload: { usage: { inputTokens: 7, outputTokens: 3 } },
      }) + '\n',
    );
    const r = await aggregateUsage({ sessionsDir: SESSIONS });
    expect(r.byModel).toEqual([{ model: 'unknown', calls: 1, inputTokens: 7, outputTokens: 3 }]);
  });
});
