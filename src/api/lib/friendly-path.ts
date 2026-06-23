// $HOME → ~ redaction for paths shown in UI (Settings rows, cli-selector
// tooltips, etc.). Used by claude-code + codex provider health() so the
// rendered path doesn't leak the operator's home dir verbatim.
//
// Conservative: only rewrites when the path is fully prefixed by $HOME +
// '/' — guards against false positives like "/home/you/x" when
// $HOME="/home/you". Returns the input untouched when $HOME is unset
// or doesn't match (e.g. /usr/local/bin/claude is left as-is).

/**
 * Redact `$HOME` prefix in absolute paths so UI surfaces (Settings rows,
 * cli-selector tooltips, API response bodies) don't leak the operator's
 * home dir verbatim.
 *
 * Conservative — only rewrites when the path is fully prefixed by `$HOME + '/'`:
 * - `/home/you/x` + `home=/home/you` → `~/x`
 * - `/usr/local/bin/claude` (no match) → unchanged
 * - `/home/you/x` + `home=/home/you` (partial match) → unchanged
 * - empty/undefined `home` → returns input unchanged
 *
 * Locked by 5-case test (test/friendly-path.test.ts).
 * Sweep rule lives in memory: see `project_friendly_path_rule.md`.
 *
 * @param absPath - absolute filesystem path to redact
 * @param home    - $HOME value; defaults to `process.env.HOME`. Trailing
 *                  slash auto-stripped so `/home/you/` and `/home/you` both work.
 */
export function friendlyPath(absPath: string, home: string | undefined = process.env.HOME): string {
  if (!home) return absPath;
  // Strip any trailing slash from $HOME — without this, a value like
  // '/home/you/' would compose to '/home/you//' which never matches a
  // real path, so the redaction would silently fail. Setting HOME with a
  // trailing slash is unusual but valid (some users put it in .bashrc).
  const normalized = home.endsWith('/') ? home.slice(0, -1) : home;
  if (!normalized) return absPath;
  if (!absPath.startsWith(normalized + '/')) return absPath;
  return '~' + absPath.slice(normalized.length);
}
