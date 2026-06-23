/** ESM resolve hook for kit hot-reload.
 *
 *  Loaders import kit entry files with `?v=<hash>`. This hook detects the
 *  `?v=` marker on `parentURL` and appends `?v=<dep-hash>` to local relative
 *  imports so V8's module-map cache is busted ONLY when a dep actually
 *  changed (entry's combined hash already encodes the dep tree).
 *
 *  Also records the entry→dep graph during a `beginTrackEntry / endTrackEntry`
 *  window so reload-coordinator can map "this file changed" → "these entries
 *  must rehash" precisely without scanning the whole tree.
 *
 *  Ported from agenteam-os-ref/src/loaders/capability-resolve-hook.ts. */

import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// `registerHooks` lands in @types/node 22.x; runtime (Bun ≥ 1.1 / Node ≥ 22.6)
// supports it. Cast keeps tsc happy on the current @types/node ^20.
type ResolveHookCtx = { parentURL?: string; conditions?: string[] };
type ResolveHookResult = { url: string; shortCircuit?: boolean; format?: string };
type ResolveHook = (
  specifier: string,
  context: ResolveHookCtx,
  nextResolve: (specifier: string, context: ResolveHookCtx) => ResolveHookResult,
) => ResolveHookResult;
type RegisterHooksFn = (hooks: { resolve?: ResolveHook }) => void;
const registerHooks: RegisterHooksFn | undefined =
  (nodeModule as unknown as { registerHooks?: RegisterHooksFn }).registerHooks;

// ─── Hash utilities ──────────────────────────────────────────────────────────

const hashCache = new Map<string, string>();

/** Truncated SHA-1 of file content, cached. */
export function computeFileHash(filePath: string): string {
  const cached = hashCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const content = readFileSync(filePath, "utf-8");
    const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
    hashCache.set(filePath, hash);
    return hash;
  } catch {
    return "0";
  }
}

export function invalidateHash(filePath: string): void {
  hashCache.delete(filePath);
}

export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

// ─── Dependency tracking ─────────────────────────────────────────────────────

const entryDeps = new Map<string, Set<string>>();
const depToEntries = new Map<string, Set<string>>();
let currentEntry: string | null = null;
let _pendingOldDeps: Set<string> | null = null;

export function beginTrackEntry(entryPath: string): void {
  currentEntry = entryPath;
  _pendingOldDeps = entryDeps.get(entryPath) ?? null;
  entryDeps.set(entryPath, new Set());
}

export function endTrackEntry(): void {
  if (currentEntry) {
    const newDeps = entryDeps.get(currentEntry);
    if (newDeps && newDeps.size === 0 && _pendingOldDeps && _pendingOldDeps.size > 0) {
      entryDeps.set(currentEntry, _pendingOldDeps);
      for (const dep of _pendingOldDeps) {
        let entries = depToEntries.get(dep);
        if (!entries) { entries = new Set(); depToEntries.set(dep, entries); }
        entries.add(currentEntry);
      }
    } else if (_pendingOldDeps) {
      for (const dep of _pendingOldDeps) {
        if (!newDeps?.has(dep)) {
          const entries = depToEntries.get(dep);
          if (entries) {
            entries.delete(currentEntry!);
            if (entries.size === 0) depToEntries.delete(dep);
          }
        }
      }
    }
  }
  currentEntry = null;
  _pendingOldDeps = null;
}

export function getEntryDeps(entryPath: string): ReadonlySet<string> {
  return entryDeps.get(entryPath) ?? new Set();
}

export function getDepsForFile(depPath: string): ReadonlySet<string> {
  return depToEntries.get(depPath) ?? new Set();
}

// ─── Hook registration ───────────────────────────────────────────────────────

let _registered = false;

export function ensureResolveHookRegistered(): void {
  if (_registered) return;
  if (!registerHooks) {
    // Older runtime — caller falls back to entry-only `?v=hash` cache-bust
    // (no dep tree tracking). Logged once.
    if (!_warnedMissing) {
      console.warn("[kits/resolve-hook] node:module.registerHooks unavailable; dep-aware hot-reload disabled");
      _warnedMissing = true;
    }
    _registered = true;
    return;
  }
  _registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);

      if (!context.parentURL?.includes("?v=")) return result;
      if (result.url.includes("?")) return result;

      if (specifier.startsWith(".") || specifier.startsWith("#kits")) {
        try {
          const fp = fileURLToPath(result.url);
          const hash = computeFileHash(fp);

          if (currentEntry) {
            entryDeps.get(currentEntry)?.add(fp);
            let entries = depToEntries.get(fp);
            if (!entries) { entries = new Set(); depToEntries.set(fp, entries); }
            entries.add(currentEntry);
          }

          return { ...result, url: `${result.url}?v=${hash}` };
        } catch {
          return result;
        }
      }

      return result;
    },
  });
}

let _warnedMissing = false;
