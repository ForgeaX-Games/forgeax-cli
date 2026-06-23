/**
 * Phase D7 (extension) — append-only ledgers for fxpack installs + trust acks.
 *
 * Spec: 10-FXPACK-PORTABILITY §plugins-trust.yaml + installed.yaml (the audit
 *  punch-list calls this out as missing). Two yaml files live under
 *  `<destRoot>/.forgeax/`:
 *
 *    installed.yaml     — every successful installPack run appends an entry.
 *    plugins-trust.yaml — every TrustPanel decision (allow / deny) appends
 *                         an entry. Used to skip the "unsigned warning" on
 *                         re-install of a previously-acked id.
 *
 * Both files are append-only per architecture principle #7
 * (`packages/harness/rules/architecture-principles.md`). Entries are never
 * mutated — corrections append a new record with `supersedes: <prevTs>`.
 *
 * The reader does not collapse history; UI consumers fold by id and pick
 * the newest entry. This keeps the file useful for audit even after years.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const SCHEMA_VERSION = 1;

export interface InstalledEntry {
  id: string;
  slug: string;
  version: string;
  layer: 'L1' | 'L2';
  source?: string;
  sha256?: string;
  ts: string;
}

export interface TrustAckEntry {
  id: string;
  decision: 'allow' | 'deny';
  signed: boolean;
  publicKey?: string;
  ts: string;
  supersedes?: string;
  reason?: string;
}

interface LedgerFile<T> {
  version: 1;
  entries: T[];
}

function loadLedger<T>(path: string): LedgerFile<T> {
  if (!existsSync(path)) return { version: SCHEMA_VERSION, entries: [] };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) as LedgerFile<T> | null;
    if (!raw || typeof raw !== 'object') return { version: SCHEMA_VERSION, entries: [] };
    return {
      version: raw.version === SCHEMA_VERSION ? SCHEMA_VERSION : SCHEMA_VERSION,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  } catch {
    // Corrupt file → start a fresh ledger but DON'T overwrite the broken one
    // here; let the next append() rewrite it after extending. The caller can
    // see `existsSync && entries.length === 0` if they care.
    return { version: SCHEMA_VERSION, entries: [] };
  }
}

function saveLedger<T>(path: string, file: LedgerFile<T>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(file), 'utf-8');
}

function installedPath(destRoot: string): string {
  return join(destRoot, '.forgeax', 'installed.yaml');
}

function trustPath(destRoot: string): string {
  return join(destRoot, '.forgeax', 'plugins-trust.yaml');
}

export function recordInstall(destRoot: string, entry: InstalledEntry): void {
  const p = installedPath(destRoot);
  const ledger = loadLedger<InstalledEntry>(p);
  ledger.entries.push(entry);
  saveLedger(p, ledger);
}

export function readInstalled(destRoot: string): InstalledEntry[] {
  return loadLedger<InstalledEntry>(installedPath(destRoot)).entries;
}

export function recordTrust(destRoot: string, ack: TrustAckEntry): void {
  const p = trustPath(destRoot);
  const ledger = loadLedger<TrustAckEntry>(p);
  ledger.entries.push(ack);
  saveLedger(p, ledger);
}

export function readTrust(destRoot: string): TrustAckEntry[] {
  return loadLedger<TrustAckEntry>(trustPath(destRoot)).entries;
}

/** Latest decision for a given plugin id, or undefined if never seen. */
export function latestTrustFor(destRoot: string, id: string): TrustAckEntry | undefined {
  const all = readTrust(destRoot);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].id === id) return all[i];
  }
  return undefined;
}
