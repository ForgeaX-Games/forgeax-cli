/**
 * Package-history ledger.
 *
 * Records are stored in `~/.forgeax/exports-history.json`.
 * Atomic writes via tmp + rename to avoid half-written files.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export interface HistoryRecord {
  id: string;
  slug: string;
  platform: string;
  status: 'success' | 'failed';
  createdAt: number;
  durationMs: number;
  outDir?: string;
  error?: string;
  usedCachedShell?: boolean;
  rebuiltEngine?: boolean;
}

function historyFile(): string {
  return join(homedir(), '.forgeax', 'exports-history.json');
}

function loadAll(): HistoryRecord[] {
  const fp = historyFile();
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as HistoryRecord[];
  } catch {
    return [];
  }
}

function saveAll(records: HistoryRecord[]): void {
  const fp = historyFile();
  const dir = dirname(fp);
  mkdirSync(dir, { recursive: true });

  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, fp);
}

export function appendHistory(partial: Omit<HistoryRecord, 'id' | 'createdAt'>): HistoryRecord {
  const record: HistoryRecord = {
    ...partial,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  const records = loadAll();
  records.unshift(record);
  const MAX = 100;
  if (records.length > MAX) records.length = MAX;
  saveAll(records);
  return record;
}

export function listHistory(): HistoryRecord[] {
  return loadAll();
}

export function deleteHistory(id: string, cleanArtifacts = false): boolean {
  const records = loadAll();
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return false;

  if (cleanArtifacts && records[idx].outDir) {
    try {
      const outDir = records[idx].outDir!;
      if (existsSync(outDir) && statSync(outDir).isDirectory()) {
        rmSync(outDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }
  }

  records.splice(idx, 1);
  saveAll(records);
  return true;
}
