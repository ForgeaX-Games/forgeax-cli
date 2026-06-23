import { createHash } from "node:crypto";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { AgentFsAPI } from "#src/sandbox/fs-bridge.js";

const fileHashes = new Map<string, string>();

function hash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Record file content hash after read. Container paths are skipped (no host-side tracking). */
export async function recordFileRead(absPath: string, _mtimeMs: number, content: string, isPartial: boolean, fs?: AgentFsAPI): Promise<void> {
  if (fs?.needsProxy(absPath)) return;
  if (isPartial) {
    try { fileHashes.set(absPath, hash(getSandboxFs().readTextSync(absPath))); } catch { /* ignore */ }
  } else {
    fileHashes.set(absPath, hash(content));
  }
}

/** Update file content hash after write. Container paths are skipped. */
export function clearFileRead(absPath: string, _mtimeMs?: number, content?: string, fs?: AgentFsAPI): void {
  if (fs?.needsProxy(absPath)) return;
  if (content !== undefined) fileHashes.set(absPath, hash(content));
  else fileHashes.delete(absPath);
}

/**
 * Content-hash based staleness check — immune to mtime-only changes
 * from FSWatcher / hot-reload / IDE save events.
 * Container paths always return undefined (not stale) — no host tracking available.
 */
export async function checkStaleness(absPath: string, fs?: AgentFsAPI): Promise<string | undefined> {
  if (fs?.needsProxy(absPath)) return undefined;
  const h = fileHashes.get(absPath);
  if (!h) return undefined;
  try {
    if (hash(getSandboxFs().readTextSync(absPath)) === h) return undefined;
  } catch { /* treat as stale */ }
  return "File has been externally modified since last read (content changed). Re-read the file before editing to avoid overwriting changes.";
}
