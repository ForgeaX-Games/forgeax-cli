/** /api/logs —— 前端观察/调试流（Console / Network / Info / Server）的落盘入口。
 *
 *  这几条流原本只活在浏览器 store 里（in-memory, cap 500），刷新/崩溃即丢失，
 *  没法事后 debug。前端 `lib/logSink.ts` 批量把它们 POST 到这里，按 stream
 *  各自 append 到 `<projectRoot>/.forgeax/logs/<stream>.jsonl`（纯 append JSONL）。
 *  体量靠 size-based 轮转兜底：超过 MAX_BYTES 就把当前文件挪成 `<stream>.1.jsonl`
 *  （只留一份备份，再超就覆盖）——单流磁盘上限 ≈ 2×MAX_BYTES。
 *
 *  ⚠ ALL fs is ASYNC (node:fs/promises). The previous impl used appendFileSync /
 *  readFileSync, which BLOCK bun's single event loop on every POST/GET — a log
 *  flood or a multi-MB GET froze the whole server (same failure class as the
 *  reset-sessions sync-rmSync freeze). Appends are serialized PER STREAM via a
 *  promise chain so concurrent batches never interleave partial lines.
 *
 *  GET 仅为 debug 便利（tail N 行，bounded read），渲染器/UI 不依赖它。
 */

import { mkdir, stat, rename, appendFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';

// 'server' carries server-side request + error logs (see main.ts middleware).
const VALID_STREAMS = new Set(['console', 'network', 'info', 'server']);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB/stream, then rotate to <stream>.1.jsonl
const TAIL_READ_BYTES = 512 * 1024; // GET tail reads at most the last 512KB

// Per-stream append serialization: chain each stream's writes so two concurrent
// POST batches can't interleave and produce a torn JSON line. The stored chain
// is kept resolved (.catch) so one failure doesn't poison subsequent writes; the
// returned promise still rejects so the caller can surface the error.
const appendChains = new Map<string, Promise<unknown>>();
function serializeAppend(stream: string, task: () => Promise<void>): Promise<void> {
  const prev = appendChains.get(stream) ?? Promise.resolve();
  const next = prev.then(task, task);
  appendChains.set(stream, next.catch(() => {}));
  return next;
}

/** `<projectRoot>/.forgeax/logs`. */
export function logsDir(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax', 'logs');
}

/** Append JSONL entries to a stream file (async, serialized, size-rotated).
 *  Shared by the POST route and server-side loggers (main.ts request/error log). */
export async function appendToStream(dir: string, stream: string, entries: unknown[]): Promise<void> {
  if (!entries.length) return;
  await serializeAppend(stream, async () => {
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${stream}.jsonl`);
    try {
      const st = await stat(file);
      if (st.size > MAX_BYTES) await rename(file, resolve(dir, `${stream}.1.jsonl`));
    } catch { /* no file or rotate failed — best effort */ }
    await appendFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  });
}

export function createLogsRouter(projectRoot: string) {
  const r = new Hono();
  const dir = resolve(projectRoot, '.forgeax', 'logs');
  const fileFor = (s: string) => resolve(dir, `${s}.jsonl`);

  r.post('/', async (c) => {
    let body: { stream?: unknown; entries?: unknown; sessionId?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const stream = String(body.stream ?? '');
    if (!VALID_STREAMS.has(stream)) return c.json({ error: 'invalid stream' }, 400);
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) return c.json({ ok: true, written: 0 });
    // Stamp the browser-session correlation id so the three client streams of one
    // session are joinable on disk (sid). Non-object entries are left untouched.
    const sid = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const stamped = sid
      ? entries.map((e) => (e && typeof e === 'object' && !Array.isArray(e) ? { sid, ...(e as object) } : e))
      : entries;
    try {
      await appendToStream(dir, stream, stamped);
      return c.json({ ok: true, written: entries.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  r.get('/:stream', async (c) => {
    const stream = c.req.param('stream');
    if (!VALID_STREAMS.has(stream)) return c.json({ error: 'invalid stream' }, 400);
    const tail = Math.min(2000, Math.max(1, Number(c.req.query('tail') ?? 200)));
    const file = fileFor(stream);
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(file, 'r');
    } catch {
      return c.json({ stream, entries: [], total: 0 });
    }
    try {
      const { size } = await fh.stat();
      // Bounded read: only the last TAIL_READ_BYTES, never the whole file.
      const readBytes = Math.min(size, TAIL_READ_BYTES);
      const buf = Buffer.alloc(readBytes);
      await fh.read(buf, 0, readBytes, size - readBytes);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      // If we started mid-file, the first line is likely partial — drop it.
      if (readBytes < size && lines.length > 0) lines.shift();
      const slice = lines.slice(-tail).map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
      // total = lines available in the read window (not the whole file — bounded).
      return c.json({ stream, entries: slice, total: lines.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    } finally {
      await fh.close();
    }
  });

  return r;
}
