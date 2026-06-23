/**
 * /api/changelog — parsed forgeax-studio CHANGELOG.md entries.
 *
 *   GET  /api/changelog        → { entries: ChangelogEntry[] }
 *   GET  /api/changelog?raw=1  → text/plain · raw markdown (debug)
 *
 * Parses the version sections only (skips the rules/header) — clients show
 * a clean list of "what changed when" without the meta-documentation.
 *
 * Section format expected (Keep-a-Changelog–style):
 *   ## v0.M.D.N — YYYY-MM-DD · Title text
 *   **代码增量**:9 仓 +X / -Y(净 ±Z)· 主仓 +A / -B · N commits 当日
 *   **主题**:one-line summary
 *
 *   - **【特性】** lorem ipsum
 *   - **【体验】** lorem
 *   ...
 *
 * Source-of-truth: forgeax-studio/CHANGELOG.md (repo root).
 */

import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ChangelogEntry {
  version: string;          // "v0.5.18.486"
  date: string;             // "2026-05-18"
  title: string;            // "Bus 接进 UI · wb-* 工作台铺底"
  delta?: string;           // raw "代码增量" line (without prefix)
  theme?: string;           // raw "主题" line  (without prefix)
  body: string;             // remaining markdown body (bullets + sub-headings)
}

let cached: { mtime: number; entries: ChangelogEntry[]; raw: string } | null = null;

function locateChangelog(): string | null {
  const candidates = [
    resolve(process.cwd(), 'CHANGELOG.md'),
    resolve(process.cwd(), '..', 'CHANGELOG.md'),
    resolve(process.cwd(), '..', '..', 'CHANGELOG.md'),
    resolve(import.meta.dir ?? __dirname, '..', '..', '..', '..', 'CHANGELOG.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function parseChangelog(raw: string): ChangelogEntry[] {
  // Split on top-level `^## v0.*` headings. Anything before the first match
  // is the rules header — drop it (the user's instruction: "前面的不用,
  // 只用实际后面有效的内容").
  const lines = raw.split('\n');
  const entries: ChangelogEntry[] = [];

  // Find first version heading.
  let i = lines.findIndex((l) => /^##\s+v0\.\d+\.\d+\.\d+\b/.test(l));
  while (i >= 0 && i < lines.length) {
    const headerMatch = /^##\s+(v0\.\d+\.\d+\.\d+)\s*—\s*(\d{4}-\d{2}-\d{2})\s*·?\s*(.*)$/.exec(lines[i]);
    if (!headerMatch) {
      i++;
      continue;
    }
    const version = headerMatch[1];
    const date = headerMatch[2];
    const title = headerMatch[3].trim();

    // Walk until next `## v0.*` or end of file.
    const bodyStart = i + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length && !/^##\s+v0\.\d+\.\d+\.\d+\b/.test(lines[bodyEnd])) {
      // Also stop at `---` divider followed by "之前·" or "📦 自动化" footer.
      if (/^---\s*$/.test(lines[bodyEnd])) {
        const next = lines[bodyEnd + 1] ?? '';
        if (/^##\s+(之前|📦)/.test(next) || /^>\s+自动化/.test(next)) break;
      }
      bodyEnd++;
    }

    const bodyLines = lines.slice(bodyStart, bodyEnd);
    // Pull out 代码增量 / 主题 lines as structured fields.
    let delta: string | undefined;
    let theme: string | undefined;
    const rest: string[] = [];
    for (const ln of bodyLines) {
      const dm = /^\*\*代码增量\*\*[::]\s*(.*)$/.exec(ln);
      if (dm) { delta = dm[1].trim(); continue; }
      const tm = /^\*\*主题\*\*[::]\s*(.*)$/.exec(ln);
      if (tm) { theme = tm[1].trim(); continue; }
      rest.push(ln);
    }
    // Trim leading/trailing blank lines.
    while (rest.length && rest[0].trim() === '') rest.shift();
    while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();

    entries.push({ version, date, title, delta, theme, body: rest.join('\n') });
    i = bodyEnd;
  }
  return entries;
}

function loadAndParse(): { entries: ChangelogEntry[]; raw: string } | null {
  const path = locateChangelog();
  if (!path) return null;
  try {
    const stat = require('node:fs').statSync(path) as { mtimeMs: number };
    if (cached && cached.mtime === stat.mtimeMs) return cached;
    const raw = readFileSync(path, 'utf-8');
    const entries = parseChangelog(raw);
    cached = { mtime: stat.mtimeMs, entries, raw };
    return cached;
  } catch {
    return null;
  }
}

export function createChangelogRouter() {
  const app = new Hono();
  app.get('/', (c) => {
    const data = loadAndParse();
    if (!data) return c.json({ entries: [], error: 'CHANGELOG.md not found' }, 200);
    if (c.req.query('raw') === '1') {
      return c.text(data.raw, 200, { 'content-type': 'text/markdown; charset=utf-8' });
    }
    return c.json({ entries: data.entries });
  });
  return app;
}
