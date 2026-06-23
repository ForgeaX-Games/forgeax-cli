/** Mirror of browser localStorage UI prefs under `.forgeax/prefs/browser-localStorage.json`.
 *  Used by export-instance / import-instance for cross-machine layout migration. */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const BROWSER_LOCAL_STORAGE_PREFS_FILE = 'browser-localStorage.json';

export interface BrowserLocalStorageSnapshot {
  v: 1;
  exportedAt: string;
  origin?: string;
  entries: Record<string, string>;
}

export function browserLocalStoragePath(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax/prefs', BROWSER_LOCAL_STORAGE_PREFS_FILE);
}

export function readBrowserLocalStorageSnapshot(projectRoot: string): BrowserLocalStorageSnapshot | null {
  const p = browserLocalStoragePath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as BrowserLocalStorageSnapshot;
    if (parsed?.v !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeBrowserLocalStorageSnapshot(
  projectRoot: string,
  snapshot: BrowserLocalStorageSnapshot,
): void {
  const p = browserLocalStoragePath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}
