/** Telemetry replay + tail —— the read side of the trace/log telemetry plane,
 *  feeding the Observatory `/api/observatory/telemetry` SSE route (todo 038).
 *
 *  The host telemetry sink (server/kernel/telemetry-file-sink.ts) APPENDS span
 *  records to `<sid>/logs/trace.jsonl` and log records to `<sid>/logs/log.jsonl`,
 *  where `<sid>/logs` is resolved by `sessionLogsDir` —— the SSOT shared with
 *  the writer (todo 038 D2/F1). We read the SAME directory here so replay returns
 *  exactly what was written; reading the user-root (as the ledger does) would
 *  read empty (F1: the two-roots bug this fusion fixes).
 *
 *  Two entry points, mirroring the ledger replay→live-tail split of `/events`,
 *  but the live source is `fs.watch` on the jsonl files (NOT the in-process
 *  eventBus) —— forgeax-core telemetry arrives via RPC→sink→disk, never the bus.
 *
 *  Fail-soft throughout: missing dir/files → empty, never throws; a malformed
 *  line is skipped (zod reject), the rest stream on. Telemetry observability
 *  must never reach back and break the trajectory plane.
 */

import { existsSync, readdirSync, openSync, readSync, closeSync, statSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPathManager } from '../fs/path-manager';
import { TelemetryRecord, type SpanData } from '@forgeax/types';

const TRACE_FILE = 'trace.jsonl';
const LOG_FILE = 'log.jsonl';

/** Resolve a session's telemetry logs dir via the SAME PathManager the host
 *  telemetry sink writes through (telemetry-file-sink default =
 *  getPathManager().session(sid).logsDir()). Going through the shared singleton
 *  guarantees reader == writer regardless of the active SessionLayout
 *  (studio = project/game-local; standalone cli = user root) — the single-
 *  resolver convergence (方案B PR1 D1) the trace/log fusion now builds on. */
function sessionLogsDir(sid: string): string {
  return getPathManager().session(sid).logsDir();
}

/** Sort key: span → startTs, log → ts. Both are epoch-ms producer timestamps. */
function sortKey(rec: TelemetryRecord): number {
  return rec.kind === 'span' ? rec.startTs : rec.ts;
}

/** zod-validate one JSONL line into a TelemetryRecord; null on any parse/shape
 *  failure (Fail-soft — bad line is dropped, never aborts the batch). */
function parseLine(line: string): TelemetryRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: unknown;
  try { json = JSON.parse(trimmed); } catch { return null; }
  const res = TelemetryRecord.safeParse(json);
  return res.success ? res.data : null;
}

/** A span is "final" once its endTs has arrived (provisional → final, S1). */
function isFinalSpan(s: SpanData): boolean {
  return s.endTs !== undefined;
}

/** Merge a span into the dedup map by spanId: a final span always wins; a
 *  provisional one is kept only until its final overwrites it. Latest of two
 *  same-finality records wins (append order = newest last). */
function mergeSpan(bySpanId: Map<string, SpanData>, next: SpanData): void {
  const prev = bySpanId.get(next.spanId);
  // Drop a late provisional that would clobber an already-final span.
  if (prev && isFinalSpan(prev) && !isFinalSpan(next)) return;
  bySpanId.set(next.spanId, next);
}

/**
 * Read `<sid>/logs/{trace,log}.jsonl` in full → zod-validate each line (bad
 * lines skipped) → dedup provisional→final spans by spanId → merge spans + logs
 * → sort ascending by (startTs | ts). Missing dir/files → []. Never throws.
 */
export async function replaySessionTelemetry(sid: string): Promise<TelemetryRecord[]> {
  const dir = sessionLogsDir(sid);
  if (!existsSync(dir)) return [];

  const bySpanId = new Map<string, SpanData>();
  const logs: TelemetryRecord[] = [];

  for (const fname of [TRACE_FILE, LOG_FILE]) {
    const file = join(dir, fname);
    if (!existsSync(file)) continue;
    let raw: string;
    try { raw = await readFile(file, 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const rec = parseLine(line);
      if (!rec) continue;
      if (rec.kind === 'span') mergeSpan(bySpanId, rec);
      else logs.push(rec);
    }
  }

  const merged: TelemetryRecord[] = [...bySpanId.values(), ...logs];
  merged.sort((a, b) => sortKey(a) - sortKey(b));
  return merged;
}

/** Per-file tail cursor: byte offset already consumed + partial-line carry. */
interface FileCursor {
  offset: number;
  carry: string;
}

/** Read bytes [cursor.offset, size) of `file`, split into complete lines, parse
 *  each, and invoke onRecord. Partial trailing line is carried to next call.
 *  A shrink (size < offset) means rotation/truncation → reset to start. */
function drainFile(file: string, cursor: FileCursor, onRecord: (rec: TelemetryRecord) => void): void {
  let size: number;
  try { size = statSync(file).size; } catch { return; }
  if (size < cursor.offset) { cursor.offset = 0; cursor.carry = ''; } // rotated/truncated
  if (size <= cursor.offset) return;

  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return; }
  try {
    const len = size - cursor.offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, cursor.offset);
    cursor.offset += read;
    cursor.carry += buf.toString('utf-8', 0, read);
  } finally {
    closeSync(fd);
  }

  let nl: number;
  while ((nl = cursor.carry.indexOf('\n')) >= 0) {
    const line = cursor.carry.slice(0, nl);
    cursor.carry = cursor.carry.slice(nl + 1);
    const rec = parseLine(line);
    if (rec) onRecord(rec);
  }
}

/**
 * Watch `<sid>/logs/{trace,log}.jsonl` for appended lines and stream each new
 * record to `onRecord`. Starts at end-of-file (only NEW appends are emitted;
 * replaySessionTelemetry already delivered the backlog). Returns an unsubscribe.
 *
 * Watches the directory (file-level watches break across rotation/recreate),
 * re-draining both files on any directory event. Missing dir → no-op unsub.
 */
export function tailSessionTelemetry(
  sid: string,
  onRecord: (rec: TelemetryRecord) => void,
): () => void {
  const dir = sessionLogsDir(sid);
  if (!existsSync(dir)) return () => {};

  const cursors: Record<string, FileCursor> = {};
  for (const fname of [TRACE_FILE, LOG_FILE]) {
    const file = join(dir, fname);
    let offset = 0;
    try { offset = statSync(file).size; } catch { /* not created yet → 0 */ }
    cursors[fname] = { offset, carry: '' };
  }

  const drainAll = (): void => {
    for (const fname of [TRACE_FILE, LOG_FILE]) {
      try { drainFile(join(dir, fname), cursors[fname], onRecord); } catch { /* fail-soft */ }
    }
  };

  let watcher: FSWatcher | null = null;
  try {
    // Only react to our two files; other logs (debug.log, …) share the dir.
    watcher = watch(dir, (_event, filename) => {
      if (filename && filename !== TRACE_FILE && filename !== LOG_FILE) return;
      drainAll();
    });
  } catch {
    return () => {};
  }
  // Best-effort: also catch readdir at start in case files appeared between
  // existsSync(dir) and watch() (cheap, idempotent — cursors gate re-emit).
  try { if (readdirSync(dir).length) drainAll(); } catch { /* ignore */ }

  return () => { try { watcher?.close(); } catch { /* ignore */ } };
}
