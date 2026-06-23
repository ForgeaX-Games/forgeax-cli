// Stub: no-op debug logger (replaces claude-code debug.ts)
export function logForDebugging(_label: string, ..._args: unknown[]): void {}
export function flushDebugLogs(): void {}

// ── Paste-freeze diagnostic logger ──
//
// Gated by env var INK_PASTE_DEBUG=1. Writes a single append-only log file
// at $HOME/.agenteam/cache/renderer/paste-debug.log. Captures timestamps
// for the paste lifecycle so a freeze leaves an obvious "last event before
// the event loop went dark" footprint that tells us *where* it got stuck.
//
// Heartbeat fires every 250ms — if the event loop is blocked, the heartbeat
// stops, and the gap between the last heartbeat and the eventual unfreeze
// (or session kill) tells us the block duration.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ENABLED = process.env["INK_PASTE_DEBUG"] === "1";
const LOG_PATH = join(homedir(), ".agenteam", "cache", "renderer", "paste-debug.log");

let initialized = false;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function ensureInit(): void {
  if (initialized || !ENABLED) return;
  initialized = true;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `\n=== session pid=${process.pid} t=${Date.now()} ===\n`);
    heartbeatTimer = setInterval(() => {
      try { appendFileSync(LOG_PATH, `${Date.now()} heartbeat\n`); } catch { /* ignore */ }
    }, 250);
    heartbeatTimer.unref?.();
  } catch { /* best-effort */ }
}

export function pasteDebug(event: string, extra?: Record<string, unknown>): void {
  if (!ENABLED) return;
  ensureInit();
  try {
    const line = extra
      ? `${Date.now()} ${event} ${JSON.stringify(extra)}\n`
      : `${Date.now()} ${event}\n`;
    appendFileSync(LOG_PATH, line);
  } catch { /* ignore */ }
}

export function pasteDebugEnabled(): boolean {
  return ENABLED;
}
