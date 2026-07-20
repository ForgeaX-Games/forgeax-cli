/**
 * Path validation (CWE-22 hardening) — pure guard for file-tool target paths.
 *
 * File tools (write/edit/read) resolve their target only through the permission
 * engine's string judgement: the OS sandbox decorates the *terminal* seam, not the
 * file seam (`ctx.sandboxFs` = `NodeSandboxFs` passes straight through, and the
 * sidecar host uses a bare `NodeTerminal`). This is the only guard on that seam, so
 * it is worth hardening — but narrowly, to CWE-22 (path traversal), NOT to CC's full
 * shell-expansion clause (`$VAR`/`~user`/`%VAR%`): core file paths never re-enter a
 * shell and `node:fs` performs no such expansion, so rejecting those would only
 * mis-reject legitimate filenames that happen to contain `$` / `~`.
 *
 * Two verdict tiers (never a blanket deny):
 *   - **deny** (structurally invalid, never legal): NUL / C0 control chars (any op);
 *     glob wildcards in a *write* target.
 *   - **ask** (approvable, but must override an always-allow / acceptEdits): a *write*
 *     whose canonical target escapes the working directory. `/tmp`-style writes are
 *     legitimate, so this stays a user-approval gate (like the OS sandbox, which also
 *     permits cwd + temp); `os.tmpdir()` is exempted outright.
 *
 * Boundary: mechanism layer, pure — only `node:` builtins. Cross-platform. At most a
 * single `realpath` touch per path, and only in the escape branch (the common in-cwd
 * write does zero filesystem I/O, matching engine.ts `isWithinCwd`).
 */
import {
  isAbsolute as pathIsAbsolute,
  normalize as pathNormalize,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type PathOp = 'read' | 'write';

/** Two-tier verdict: `ok` (proceed), `deny` (hard reject), `ask` (forced approval). */
export type PathVerdict = { verdict: 'ok' } | { verdict: 'ask' | 'deny'; reason: string; scope: string };

/** NUL byte + C0 control chars — never legal in a path a file tool should touch. */
const CONTROL_CHAR_REGEX = /[\x00-\x1f]/;
/**
 * Glob wildcards a literal-write tool would write verbatim. `*`/`?` in a write target
 * signal either an error or an attempt to dodge base-dir validation (CC:
 * `/allowed/*.txt` validates `/allowed` but writes the literal `*`). `[...]`/`{...}`
 * are intentionally NOT flagged: they are common literal filename characters
 * (`foo[1].txt`, `{a,b}.log`) that `node:fs` writes verbatim with no expansion, so
 * rejecting them would mis-reject legitimate paths.
 */
const WRITE_GLOB_REGEX = /[*?]/;

function controlCharLabel(s: string): string {
  const m = CONTROL_CHAR_REGEX.exec(s);
  if (!m) return 'control character';
  const code = m[0].charCodeAt(0);
  return code === 0 ? 'NUL byte' : `control character (0x${code.toString(16).padStart(2, '0')})`;
}

/** `realpathSync` with graceful degradation — non-existent paths (typical for write
 *  targets) fall back to the input; never throws. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** target canonical 落在 base canonical 内(含 base 自身)。纯字符串(输入已 absolute)。 */
function isWithin(canonTarget: string, canonBase: string): boolean {
  const rel = pathRelative(canonBase, canonTarget);
  return rel === '' || (!rel.startsWith('..') && !pathIsAbsolute(rel));
}

/**
 * Validate a file-tool target path. Pure + deterministic for the common case; a single
 * bounded `realpath` recheck runs only when the pure-string test says the write escapes
 * cwd (so legitimate in-cwd writes — including under symlinked temp roots — never touch
 * the filesystem and never mis-ask).
 */
export function validateTargetPath(target: string, op: PathOp, cwd: string = process.cwd()): PathVerdict {
  // ① NUL / control chars — deny for any op (structurally invalid path).
  if (CONTROL_CHAR_REGEX.test(target)) {
    return { verdict: 'deny', reason: `Path contains a ${controlCharLabel(target)} and cannot be used.`, scope: 'control-char' };
  }

  // Reads are not cwd-confined here; the only read hazard (control chars) is handled above.
  if (op !== 'write') return { verdict: 'ok' };

  // ② write-glob — deny (write tools use paths literally; `*`/`?` never write correctly).
  if (WRITE_GLOB_REGEX.test(target)) {
    return {
      verdict: 'deny',
      reason: 'Glob wildcards (*, ?) are not allowed in write targets; specify an exact file path.',
      scope: 'glob',
    };
  }

  // ③ write escaping cwd — forced ask. Canonicalize `..` / absolute uniformly, then test
  //    containment. Pure-string first (zero fs I/O, correct for symlinked temp roots);
  //    a single realpath recheck only if the pure test flags an escape.
  const cwdAbs = pathResolve(cwd);
  const targetAbs = pathNormalize(pathIsAbsolute(target) ? target : pathResolve(cwdAbs, target));
  const tmpAbs = pathResolve(tmpdir());
  if (isWithin(targetAbs, cwdAbs) || isWithin(targetAbs, tmpAbs)) {
    return { verdict: 'ok' };
  }
  // Escape per pure string — confirm against symlink-resolved paths before forcing ask.
  // realpath degrades to normalize on missing paths, so this only ever *reduces* asks.
  const targetReal = realpathOrSelf(targetAbs);
  if (isWithin(targetReal, realpathOrSelf(cwdAbs)) || isWithin(targetReal, realpathOrSelf(tmpAbs))) {
    return { verdict: 'ok' };
  }
  return {
    verdict: 'ask',
    reason: `Write target "${target}" resolves outside the working directory; explicit approval required.`,
    scope: 'escape',
  };
}
