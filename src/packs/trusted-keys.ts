/**
 * Phase D7 (extension) — `~/.forgeax/trusted-keys.yaml` PKI lookup.
 *
 * Spec: 10-FXPACK-PORTABILITY §4. The signing layer (`signing.ts`) only
 * proves "these bytes were signed by the holder of <publicKey>". This module
 * answers the next question — "do I trust that key?" — by mapping public
 * keys to a label + trust verdict that the importer's TrustPanel surfaces
 * to the user.
 *
 * The store is a plain yaml file under the user's `~/.forgeax/` (or under a
 * project's `<projectRoot>/.forgeax/` for per-project overrides):
 *
 *     version: 1
 *     keys:
 *       - publicKey: |
 *           -----BEGIN PUBLIC KEY-----
 *           MCowBQYDK2VwAyEA...
 *           -----END PUBLIC KEY-----
 *         label: "Lock Liu"
 *         trust: trusted   # trusted | revoked
 *         addedAt: "2026-05-22T...Z"
 *         notes: "official"
 *
 * Append-only on writes (architecture principle #7); revocations append a
 * new entry with `trust: revoked` and `supersedes: <prev addedAt>`.
 *
 * Lookup precedence:
 *   1. Project-level (`<projectRoot>/.forgeax/trusted-keys.yaml`) — wins
 *      when present, lets a repo pin its own publishers.
 *   2. User-level (`~/.forgeax/trusted-keys.yaml`) — fallback.
 *
 * Public keys are normalized (strip CR + trailing whitespace) before
 * compare so PEM produced on Windows still matches.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const SCHEMA_VERSION = 1;

export interface TrustedKeyEntry {
  publicKey: string;
  label: string;
  trust: 'trusted' | 'revoked';
  addedAt: string;
  notes?: string;
  supersedes?: string;
}

interface TrustedKeyFile {
  version: 1;
  keys: TrustedKeyEntry[];
}

function normalize(pk: string): string {
  return pk.replace(/\r/g, '').trim();
}

function load(path: string): TrustedKeyFile {
  if (!existsSync(path)) return { version: SCHEMA_VERSION, keys: [] };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) as TrustedKeyFile | null;
    if (!raw || typeof raw !== 'object') return { version: SCHEMA_VERSION, keys: [] };
    return {
      version: SCHEMA_VERSION,
      keys: Array.isArray(raw.keys) ? raw.keys : [],
    };
  } catch {
    // Corrupt file — return empty so callers still get default-deny lookup.
    return { version: SCHEMA_VERSION, keys: [] };
  }
}

function save(path: string, file: TrustedKeyFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(file), 'utf-8');
}

/** Resolve a `<root>/.forgeax/trusted-keys.yaml` path. */
function pathFor(root: string): string {
  return join(root, '.forgeax', 'trusted-keys.yaml');
}

export interface KeyVerdict {
  /** Latest matching entry's verdict, or 'unknown' when not found. */
  trust: 'trusted' | 'revoked' | 'unknown';
  label?: string;
  /** 'project' wins; falls back to 'user'; 'none' when no entry matched. */
  source: 'project' | 'user' | 'none';
}

export interface LookupOpts {
  /** Project root — `<projectRoot>/.forgeax/trusted-keys.yaml` wins when
   *  present. Optional; omit for user-only lookup. */
  projectRoot?: string;
  /** User home — defaults to `os.homedir()`. Override for tests. */
  homeDir?: string;
}

/** Look up a public key. Returns `unknown` when no match in either store. */
export function lookupTrustedKey(publicKey: string, opts: LookupOpts = {}): KeyVerdict {
  const target = normalize(publicKey);
  const home = opts.homeDir ?? homedir();
  const sources: Array<{ source: 'project' | 'user'; path: string }> = [];
  if (opts.projectRoot) sources.push({ source: 'project', path: pathFor(opts.projectRoot) });
  sources.push({ source: 'user', path: pathFor(home) });

  for (const { source, path } of sources) {
    const file = load(path);
    // Walk in reverse so the latest entry (revocation supersedes) wins.
    for (let i = file.keys.length - 1; i >= 0; i -= 1) {
      const entry = file.keys[i];
      if (normalize(entry.publicKey) === target) {
        return { trust: entry.trust, label: entry.label, source };
      }
    }
  }
  return { trust: 'unknown', source: 'none' };
}

export interface AddKeyInput {
  publicKey: string;
  label: string;
  trust?: 'trusted' | 'revoked';
  notes?: string;
  supersedes?: string;
  /** Project root for project-scoped trust (vs. user-home). */
  projectRoot?: string;
  homeDir?: string;
}

/** Append a trusted-keys entry. Returns the path written. */
export function recordTrustedKey(input: AddKeyInput): string {
  const home = input.homeDir ?? homedir();
  const path = input.projectRoot
    ? pathFor(input.projectRoot)
    : pathFor(home);
  const file = load(path);
  file.keys.push({
    publicKey: input.publicKey,
    label: input.label,
    trust: input.trust ?? 'trusted',
    addedAt: new Date().toISOString(),
    notes: input.notes,
    supersedes: input.supersedes,
  });
  save(path, file);
  return path;
}

/** List all trusted-keys entries, project then user. Useful for SettingsPanel. */
export function listTrustedKeys(opts: LookupOpts = {}): Array<{ source: 'project' | 'user'; entry: TrustedKeyEntry }> {
  const home = opts.homeDir ?? homedir();
  const out: Array<{ source: 'project' | 'user'; entry: TrustedKeyEntry }> = [];
  if (opts.projectRoot) {
    for (const e of load(pathFor(opts.projectRoot)).keys) out.push({ source: 'project', entry: e });
  }
  for (const e of load(pathFor(home)).keys) out.push({ source: 'user', entry: e });
  return out;
}
