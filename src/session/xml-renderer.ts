/**
 * xml-renderer.ts — Debounced async XML renderer.
 *
 * Regenerates ledger.xml from all event shards in the active session directory.
 * Rendering is debounced to avoid thrashing during rapid event bursts.
 *
 * The render queue is keyed on `(agentId, sessionId)` — same agentId across
 * two sessions has two independent ledger.xml files in different directories.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { jsonlToXML } from "./xml.js";
import { getPathManager } from "../fs/path-manager.js";

const DEBOUNCE_MS = 500;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function renderKey(agentId: string, sessionId: string | null | undefined): string {
  return `${sessionId ?? "__legacy__"}::${agentId}`;
}

/**
 * Schedule an XML render for one (agent, session) pair.
 * Repeated calls within the debounce window are coalesced.
 *
 * sessionId is optional for back-compat with the pre-session legacy bucket,
 * which AgentLedger uses when no SessionRuntime owns the agent.
 */
export function scheduleRender(agentId: string, sessionId?: string | null): void {
  const key = renderKey(agentId, sessionId);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);

  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      renderNow(agentId, sessionId).catch(() => {});
    }, DEBOUNCE_MS),
  );
}

/**
 * Resolve the active shard directory by reading ledger.json pointer.
 * Returns null if no active shard is set.
 */
function resolveActiveShardDir(agentId: string, sessionId?: string | null): string | null {
  const ledgerRoot = getPathManager().team().ledgersFor(agentId, sessionId);
  try {
    const pointerPath = join(ledgerRoot, "ledger.json");
    const raw = readFileSync(pointerPath, "utf-8");
    const data = JSON.parse(raw) as { activeShardId?: string };
    if (!data.activeShardId) return null;
    const dir = join(ledgerRoot, data.activeShardId);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Immediately render ledger.xml from all event files in the active shard.
 */
export async function renderNow(agentId: string, sessionId?: string | null): Promise<void> {
  const shardDir = resolveActiveShardDir(agentId, sessionId);
  if (!shardDir) return;

  let shards: string[];
  try {
    shards = readdirSync(shardDir)
      .filter((f: string) => /^events-\d+\.jsonl$/.test(f))
      .sort((a: string, b: string) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      })
      .map((f: string) => join(shardDir, f));
  } catch {
    return;
  }

  if (shards.length === 0) return;

  const parts: string[] = [];
  for (const p of shards) {
    try {
      parts.push(await readFile(p, "utf-8"));
    } catch { /* skip unreadable */ }
  }

  const raw = parts.join("\n");
  const xml = jsonlToXML(raw, agentId);

  const outPath = join(shardDir, "ledger.xml");
  await mkdir(shardDir, { recursive: true });
  await writeFile(outPath, xml, "utf-8");
}

/**
 * Cancel any pending render for the given (agent, session) pair (used on shutdown).
 */
export function cancelPending(agentId: string, sessionId?: string | null): void {
  const key = renderKey(agentId, sessionId);
  const timer = pending.get(key);
  if (timer) {
    clearTimeout(timer);
    pending.delete(key);
  }
}
