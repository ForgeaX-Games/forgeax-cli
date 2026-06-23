/**
 * Known-projects registry — persisted list of arbitrary workspace dirs the
 * user has "opened" via POST /api/projects/open. Lives at
 * ~/.forgeax/known-projects.json (same user-level dir as
 * defaultLedgerDir → ~/.forgeax/ledger/).
 *
 * Separate from the existing sibling-walk in /api/projects (which scans the
 * parent of FORGEAX_PROJECT_ROOT) — registered projects can be anywhere on
 * disk, so we can't derive them from the filesystem layout.
 */

import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface KnownProject {
  /** Absolute, canonical filesystem path. Comparison key. */
  path: string;
  /** Optional display label. Falls back to basename(path) at render time. */
  label?: string;
  /** Epoch ms when first registered. */
  addedAt: number;
}

interface KnownStore {
  version: 1;
  projects: KnownProject[];
}

export function knownProjectsFile(): string {
  return join(homedir(), '.forgeax', 'known-projects.json');
}

function readStore(): KnownStore {
  const file = knownProjectsFile();
  if (!existsSync(file)) return { version: 1, projects: [] };
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<KnownStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      return { version: 1, projects: [] };
    }
    return { version: 1, projects: parsed.projects.filter((p): p is KnownProject =>
      !!p && typeof p.path === 'string' && typeof p.addedAt === 'number',
    )};
  } catch {
    return { version: 1, projects: [] };
  }
}

function writeStore(store: KnownStore): void {
  const file = knownProjectsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
}

export function loadKnown(): KnownProject[] {
  return readStore().projects;
}

export function addKnown(absPath: string, label?: string): KnownProject {
  const store = readStore();
  const existing = store.projects.find((p) => p.path === absPath);
  if (existing) {
    if (label && label !== existing.label) existing.label = label;
    writeStore(store);
    return existing;
  }
  const entry: KnownProject = { path: absPath, addedAt: Date.now() };
  if (label) entry.label = label;
  store.projects.push(entry);
  writeStore(store);
  return entry;
}

export function removeKnown(absPath: string): boolean {
  const store = readStore();
  const before = store.projects.length;
  store.projects = store.projects.filter((p) => p.path !== absPath);
  if (store.projects.length === before) return false;
  writeStore(store);
  return true;
}
