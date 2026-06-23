import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PathManagerAPI } from "../core/types.js";

export interface LedgerPointerJson {
  activeShardId?: string;
  [key: string]: unknown;
}

export function ledgerPointerPath(
  pathManager: PathManagerAPI,
  agentId: string,
  sessionId?: string | null,
): string {
  return join(pathManager.team().ledgersFor(agentId, sessionId), "ledger.json");
}

export async function readLedgerPointerJson(
  pathManager: PathManagerAPI,
  agentId: string,
  sessionId?: string | null,
): Promise<LedgerPointerJson | null> {
  try {
    const raw = await readFile(ledgerPointerPath(pathManager, agentId, sessionId), "utf-8");
    return JSON.parse(raw) as LedgerPointerJson;
  } catch {
    return null;
  }
}

export async function readActiveShardId(
  pathManager: PathManagerAPI,
  agentId: string,
  sessionId?: string | null,
): Promise<string | null> {
  const data = await readLedgerPointerJson(pathManager, agentId, sessionId);
  return data?.activeShardId ?? null;
}

export async function writeLedgerPointerJson(
  pathManager: PathManagerAPI,
  agentId: string,
  data: LedgerPointerJson,
  sessionId?: string | null,
): Promise<void> {
  const path = ledgerPointerPath(pathManager, agentId, sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(data, null, 2));
  await rename(tempPath, path);
}

export async function writeActiveShardId(
  pathManager: PathManagerAPI,
  agentId: string,
  shardId: string,
  sessionId?: string | null,
): Promise<void> {
  const existing = (await readLedgerPointerJson(pathManager, agentId, sessionId)) ?? {};
  await writeLedgerPointerJson(pathManager, agentId, {
    ...existing,
    activeShardId: shardId,
  }, sessionId);
}

export async function updateLedgerPointerMeta(
  pathManager: PathManagerAPI,
  agentId: string,
  updates: Record<string, unknown>,
  sessionId?: string | null,
): Promise<void> {
  const existing = (await readLedgerPointerJson(pathManager, agentId, sessionId)) ?? {};
  await writeLedgerPointerJson(pathManager, agentId, {
    ...existing,
    ...updates,
  }, sessionId);
}
