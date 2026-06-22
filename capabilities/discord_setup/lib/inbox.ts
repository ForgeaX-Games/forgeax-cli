// @desc Discord multi-source inbox — per-DM and per-guild JSONL with independent cursors
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";

export interface InboxEntry {
  ts: number;
  direction: "in" | "out";
  source: "dm" | "guild";
  guildId?: string;
  guildName: string;
  channelName: string;
  channelId: string;
  author: string;
  authorId: string;
  messageId: string;
  content: string;
  hasAttachment: boolean;
}

interface Cursor {
  lastReadTs: number;
}

function todayFile(): string {
  return new Date().toISOString().slice(0, 10) + ".jsonl";
}

function readCursor(dir: string): Cursor {
  const p = join(dir, "cursor.json");
  if (!getSandboxFs().existsSync(p)) return { lastReadTs: 0 };
  try {
    return JSON.parse(getSandboxFs().readTextSync(p)) as Cursor;
  } catch {
    return { lastReadTs: 0 };
  }
}

function writeCursor(dir: string, cursor: Cursor): void {
  getSandboxFs().mkdirSync(dir);
  getSandboxFs().writeTextSync(join(dir, "cursor.json"), JSON.stringify(cursor) + "\n");
}

function scanJsonlUnread(dir: string, cursor: Cursor, opts?: {
  limit?: number;
  channelFilter?: string;
}): InboxEntry[] {
  if (!getSandboxFs().existsSync(dir)) return [];
  const limit = opts?.limit ?? Infinity;
  const results: InboxEntry[] = [];

  const files = getSandboxFs().readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .sort();

  for (const file of files) {
    const lines = getSandboxFs().readTextSync(join(dir, file)).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as InboxEntry;
        if (entry.ts <= cursor.lastReadTs) continue;
        if (entry.direction === "out") continue;
        if (opts?.channelFilter && entry.channelName !== opts.channelFilter) continue;
        results.push(entry);
        if (results.length >= limit) return results;
      } catch { /* skip malformed */ }
    }
  }
  return results;
}

function countJsonlUnread(dir: string, cursor: Cursor): number {
  if (!getSandboxFs().existsSync(dir)) return 0;
  let count = 0;
  const files = getSandboxFs().readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    const lines = getSandboxFs().readTextSync(join(dir, file)).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { ts: number; direction?: string };
        if (e.ts > cursor.lastReadTs && e.direction !== "out") count++;
      } catch { /* skip */ }
    }
  }
  return count;
}

// ── Path helpers ──

function dmDir(inboxBase: string): string {
  return join(inboxBase, "dm");
}

function guildInboxDir(inboxBase: string, guildId: string): string {
  return join(inboxBase, "guilds", guildId);
}

// ── Append ──

export function appendToSource(inboxBase: string, entry: InboxEntry): void {
  if (entry.source === "dm") {
    const dir = dmDir(inboxBase);
    getSandboxFs().mkdirSync(dir);
    const filePath = join(dir, `${entry.authorId}.jsonl`);
    getSandboxFs().appendTextSync(filePath, JSON.stringify(entry) + "\n");
  } else {
    const dir = guildInboxDir(inboxBase, entry.guildId ?? "unknown");
    getSandboxFs().mkdirSync(dir);
    const filePath = join(dir, todayFile());
    getSandboxFs().appendTextSync(filePath, JSON.stringify(entry) + "\n");
  }
}

// ── Read recent by channel (does NOT move cursor) ──

export function readRecentByChannel(
  inboxBase: string,
  guildId: string,
  channelId: string,
  limit = 10,
): InboxEntry[] {
  const dir = guildInboxDir(inboxBase, guildId);
  if (!getSandboxFs().existsSync(dir)) return [];

  const results: InboxEntry[] = [];
  const files = getSandboxFs().readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // newest files first

  for (const file of files) {
    const lines = getSandboxFs().readTextSync(join(dir, file)).split("\n").filter(Boolean);
    // Reverse to get newest entries first
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as InboxEntry;
        if (entry.channelId === channelId) {
          results.unshift(entry); // maintain chronological order
          if (results.length >= limit) return results;
        }
      } catch { /* skip malformed */ }
    }
  }
  return results;
}

// ── Read unread ──

export interface ReadUnreadOpts {
  source?: "dm" | "guild" | "all";
  guildId?: string;
  limit?: number;
  channelFilter?: string;
}

export function readUnread(inboxBase: string, opts?: ReadUnreadOpts): InboxEntry[] {
  const source = opts?.source ?? "all";
  const limit = opts?.limit ?? 50;
  const results: InboxEntry[] = [];

  if (source === "dm" || source === "all") {
    const dir = dmDir(inboxBase);
    if (getSandboxFs().existsSync(dir)) {
      const cursor = readCursor(dir);
      const remaining = limit - results.length;
      results.push(...scanJsonlUnread(dir, cursor, { limit: remaining, channelFilter: opts?.channelFilter }));
    }
  }

  if (source === "guild" || source === "all") {
    const guildsBase = join(inboxBase, "guilds");
    if (getSandboxFs().existsSync(guildsBase)) {
      const guildDirs = opts?.guildId
        ? [opts.guildId]
        : getSandboxFs().readdirSync(guildsBase)
            .filter(d => getSandboxFs().statSync(join(guildsBase, d))?.isDirectory)
            .map(d => d);

      for (const gid of guildDirs) {
        if (results.length >= limit) break;
        const dir = join(guildsBase, gid);
        if (!getSandboxFs().existsSync(dir)) continue;
        const cursor = readCursor(dir);
        const remaining = limit - results.length;
        results.push(...scanJsonlUnread(dir, cursor, { limit: remaining, channelFilter: opts?.channelFilter }));
      }
    }
  }

  return results;
}

// ── Mark read ──

export function markRead(inboxBase: string, opts?: {
  source?: "dm" | "guild" | "all";
  guildId?: string;
  upToTs?: number;
}): void {
  const ts = opts?.upToTs ?? Date.now();
  const source = opts?.source ?? "all";

  if (source === "dm" || source === "all") {
    const dir = dmDir(inboxBase);
    if (getSandboxFs().existsSync(dir)) writeCursor(dir, { lastReadTs: ts });
  }

  if (source === "guild" || source === "all") {
    const guildsBase = join(inboxBase, "guilds");
    if (getSandboxFs().existsSync(guildsBase)) {
      const guildDirs = opts?.guildId
        ? [opts.guildId]
        : getSandboxFs().readdirSync(guildsBase)
            .filter(d => getSandboxFs().statSync(join(guildsBase, d))?.isDirectory)
            .map(d => d);

      for (const gid of guildDirs) {
        const dir = join(guildsBase, gid);
        if (getSandboxFs().existsSync(dir)) writeCursor(dir, { lastReadTs: ts });
      }
    }
  }
}

// ── Count unread ──

export interface UnreadCounts {
  dm: number;
  guild: number;
  total: number;
}

export function countUnread(inboxBase: string): UnreadCounts {
  let dm = 0;
  let guild = 0;

  const dDir = dmDir(inboxBase);
  if (getSandboxFs().existsSync(dDir)) {
    const cursor = readCursor(dDir);
    dm = countJsonlUnread(dDir, cursor);
  }

  const guildsBase = join(inboxBase, "guilds");
  if (getSandboxFs().existsSync(guildsBase)) {
    try {
      const guildDirs = getSandboxFs().readdirSync(guildsBase)
        .filter(d => getSandboxFs().statSync(join(guildsBase, d))?.isDirectory);
      for (const d of guildDirs) {
        const dir = join(guildsBase, d);
        const cursor = readCursor(dir);
        guild += countJsonlUnread(dir, cursor);
      }
    } catch { /* guilds dir doesn't exist or unreadable */ }
  }

  return { dm, guild, total: dm + guild };
}
