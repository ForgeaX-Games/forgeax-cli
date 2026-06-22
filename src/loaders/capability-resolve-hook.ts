/**
 * ESM resolve hook that propagates content-hash cache keys down the
 * dependency tree of hot-reloaded capability modules, and records
 * the dependency graph for precise hot-reload triggering.
 *
 * Entry files are imported with `?v=<hash>` by base-loader.
 * This hook detects that marker on parentURL and appends `?v=<hash>`
 * (computed from the dependency's own content) to local dependencies,
 * so changed lib files get freshly loaded while unchanged ones hit
 * V8's module-map cache. Framework code (src/) and packages are
 * left untouched.
 *
 * Dependency tracking: when `currentEntry` is set (by beginTrackEntry),
 * every resolved local dependency is recorded in `entryDeps` (forward)
 * and `depToEntries` (reverse). This replaces the hardcoded `lib/`
 * scanning in the former `computePackageAuxHash`.
 */

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ─── Hash utilities ──────────────────────────────────────────────────────────

const hashCache = new Map<string, string>();

/**
 * Compute a truncated SHA-1 of a file's content.
 * Results are cached by absolute path; call `invalidateHash` when the
 * file is known to have changed on disk.
 */
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

/** Remove a cached hash so the next `computeFileHash` re-reads from disk. */
export function invalidateHash(filePath: string): void {
  hashCache.delete(filePath);
}

/** Truncate a hex string or produce a short SHA-1 from an arbitrary string. */
export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

// ─── Dependency tracking ─────────────────────────────────────────────────────

/** Forward index: entry absolute path → set of dependency absolute paths. */
const entryDeps = new Map<string, Set<string>>();

/** Reverse index: dependency absolute path → set of entry absolute paths that import it. */
const depToEntries = new Map<string, Set<string>>();

/** Currently loading entry (set by beginTrackEntry, cleared by endTrackEntry). */
let currentEntry: string | null = null;

/**
 * Begin tracking dependencies for an entry file import.
 * Clears any previous deps for this entry (handles re-import on reload).
 * Must be paired with `endTrackEntry()` in a try/finally block.
 *
 * **Concurrency note**: assumes `import()` resolves all dependencies
 * synchronously within one event loop tick. Capability modules with
 * top-level `await` would break this assumption.
 */
export function beginTrackEntry(entryPath: string): void {
  // Stash old deps — will be restored in endTrackEntry if import() hit V8 cache
  // (cache hit means resolve hook never fires → new deps set stays empty).
  currentEntry = entryPath;
  _pendingOldDeps = entryDeps.get(entryPath) ?? null;
  entryDeps.set(entryPath, new Set());
}

/** Stashed old deps from beginTrackEntry, restored if resolve hook didn't fire. */
let _pendingOldDeps: Set<string> | null = null;

/** End tracking. Must be called in a finally block after import(). */
export function endTrackEntry(): void {
  if (currentEntry) {
    const newDeps = entryDeps.get(currentEntry);
    if (newDeps && newDeps.size === 0 && _pendingOldDeps && _pendingOldDeps.size > 0) {
      // V8 cache hit — resolve hook never fired, restore old deps
      entryDeps.set(currentEntry, _pendingOldDeps);
      for (const dep of _pendingOldDeps) {
        let entries = depToEntries.get(dep);
        if (!entries) { entries = new Set(); depToEntries.set(dep, entries); }
        entries.add(currentEntry);
      }
    } else if (_pendingOldDeps) {
      // New deps recorded — clean up old reverse index entries that are no longer referenced
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

/** Get recorded dependencies for an entry (empty Set if none recorded yet). */
export function getEntryDeps(entryPath: string): ReadonlySet<string> {
  return entryDeps.get(entryPath) ?? new Set();
}

/** Reverse lookup: which entries depend on this file? Empty Set if none. */
export function getDepsForFile(depPath: string): ReadonlySet<string> {
  return depToEntries.get(depPath) ?? new Set();
}

// ─── Resolve hook ────────────────────────────────────────────────────────────

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);

    if (!context.parentURL?.includes("?v="))
      return result;
    if (result.url.includes("?"))
      return result;

    if (specifier.startsWith(".") || specifier.startsWith("#capabilities")) {
      try {
        const fp = fileURLToPath(result.url);
        const hash = computeFileHash(fp);

        // Record dependency if we're tracking an entry import
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
