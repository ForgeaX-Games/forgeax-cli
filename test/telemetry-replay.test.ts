import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, getPathManager, resetPathManager } from '../src/fs/path-manager';
import { replaySessionTelemetry, tailSessionTelemetry } from '../src/observatory/telemetry-replay';

// telemetry-replay is the read side of /api/observatory/telemetry (todo 038 P1).
// We drive it through REAL files + an isolated PathManager (no mock.module — see
// memory bun-mock-module-global-leak). Both the host sink and this reader resolve
// the logs dir via getPathManager().session(sid).logsDir(), so writing through
// that same resolver here pins reader==writer agreement (the convergence 方案B
// PR1 D1 landed; 038 reads where the sink wrote).

const SID = 'S1';
let userRoot: string;
let logsDir: string;

const span = (spanId: string, startTs: number, endTs?: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'span', traceId: 't', spanId, name: 'kernel.turn', startTs, ...(endTs !== undefined ? { endTs } : { provisional: true }), ...extra });
const log = (ts: number, msg: string, spanId?: string) =>
  JSON.stringify({ kind: 'log', ts, level: 'info', msg, ...(spanId ? { spanId } : {}) });

beforeEach(() => {
  userRoot = mkdtempSync(join(tmpdir(), 'ac038-'));
  initPathManager({ userRoot });
  logsDir = getPathManager().session(SID).logsDir();
});
afterEach(() => {
  resetPathManager();
  try { rmSync(userRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const writeTrace = (lines: string[]) => { mkdirSync(logsDir, { recursive: true }); writeFileSync(join(logsDir, 'trace.jsonl'), lines.join('\n') + '\n'); };
const writeLog = (lines: string[]) => { mkdirSync(logsDir, { recursive: true }); writeFileSync(join(logsDir, 'log.jsonl'), lines.join('\n') + '\n'); };

describe('replaySessionTelemetry', () => {
  test('missing dir → empty, never throws (AC-P1-4 ④ / AC-P3-3)', async () => {
    expect(await replaySessionTelemetry('does-not-exist')).toEqual([]);
  });

  test('merges spans + logs sorted ascending by startTs|ts (AC-P1-1)', async () => {
    writeTrace([span('a', 30), span('b', 10)]);
    writeLog([log(20, 'mid'), log(5, 'early')]);
    const recs = await replaySessionTelemetry(SID);
    expect(recs.map((r) => (r.kind === 'span' ? `span:${r.startTs}` : `log:${r.ts}`)))
      .toEqual(['log:5', 'span:10', 'log:20', 'span:30']);
  });

  test('provisional→final dedup: final wins, single entry (AC-P1-3)', async () => {
    writeTrace([span('x', 10), span('x', 10, 99)]); // provisional then final
    const recs = await replaySessionTelemetry(SID);
    const xs = recs.filter((r) => r.kind === 'span' && r.spanId === 'x');
    expect(xs).toHaveLength(1);
    expect((xs[0] as { endTs?: number }).endTs).toBe(99);
  });

  test('late provisional does not clobber an already-final span', async () => {
    writeTrace([span('x', 10, 99), span('x', 10)]); // final then stray provisional
    const recs = await replaySessionTelemetry(SID);
    const xs = recs.filter((r) => r.kind === 'span' && r.spanId === 'x');
    expect(xs).toHaveLength(1);
    expect((xs[0] as { endTs?: number }).endTs).toBe(99);
  });

  test('malformed line is skipped, the rest survive (AC-P1-4 ①)', async () => {
    writeTrace([span('a', 10), '{ not valid json', '{"kind":"span"}' /* fails schema */, span('b', 20)]);
    const recs = await replaySessionTelemetry(SID);
    expect(recs.filter((r) => r.kind === 'span').map((r) => (r as { spanId: string }).spanId)).toEqual(['a', 'b']);
  });
});

describe('tailSessionTelemetry', () => {
  test('missing dir → no-op unsubscribe, never throws', () => {
    const unsub = tailSessionTelemetry('does-not-exist', () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  test('appended line surfaces as a live record (AC-P1-2)', async () => {
    writeTrace([span('seed', 1, 2)]); // pre-existing backlog — must NOT be re-emitted
    const seen: string[] = [];
    const unsub = tailSessionTelemetry(SID, (rec) => { if (rec.kind === 'span') seen.push(rec.spanId); });
    try {
      appendFileSync(join(logsDir, 'trace.jsonl'), span('live', 10, 11) + '\n');
      // fs.watch is async; poll up to ~3s for the appended record.
      for (let i = 0; i < 60 && !seen.includes('live'); i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen).toContain('live');
      expect(seen).not.toContain('seed'); // backlog stays out of the live tail
    } finally {
      unsub();
    }
  });
});
