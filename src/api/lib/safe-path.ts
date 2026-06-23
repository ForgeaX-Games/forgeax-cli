import { resolve, relative, isAbsolute } from 'path';

// Path-prefix allowlist for /api/files (what the agent / Studio UI can
// read/write relative to FORGEAX_PROJECT_ROOT). After the 2026-05-13
// .forgeax/games refactor, games live at `<instance>/.forgeax/games/...`
// (instance-local runtime, gitignored). `packages/` is kept for legacy
// access during the transition (engine/cli/server still ship inside the
// forgeax release artifact and the Studio UI may surface them).
//
// Each entry is matched as a leading path segment list. `.forgeax` alone
// is intentionally NOT allowed — that would expose agenteam-state's session
// history + tokens to the file API; only `.forgeax/games` is whitelisted.
const ALLOWED_PREFIXES: readonly string[][] = [
  ['games'],            // legacy / release-side relative paths (pre-refactor)
  ['packages'],
  ['.forgeax', 'games'], // instance-local runtime games (canonical going forward)
];

// Kept exported for callers that just want the top-level summary. Each
// entry here is a *first* segment that resolveSafePath() may admit (the
// finer-grained .forgeax/games-only check lives in resolveSafePath).
export const ALLOWED_TOP_DIRS = ['games', 'packages', '.forgeax'] as const;

export function defaultProjectRoot(): string {
  return process.env.FORGEAX_PROJECT_ROOT ?? process.cwd();
}

export function resolveSafePath(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (rel.includes('\0')) return null;

  // Absolute paths: accept only when they fall INSIDE the project root, by
  // folding them to a project-relative path and letting the whitelist below
  // gate them exactly like a relative input. Why: the file-activity ledger
  // records ABSOLUTE paths for every file an agent touched — including engine
  // source it merely READ (e.g. .../packages/engine/.../camera.ts). Clicking
  // such an entry in the AGENTS panel sent the absolute form, which this
  // function used to reject outright (→ 400 "outside whitelist") even though
  // the file is a perfectly readable packages/** source. An absolute path
  // OUTSIDE the root folds to a `..`-prefixed relative and is still rejected
  // below, so the games/**·packages/** allowlist remains the only gate.
  let relPath = rel;
  if (isAbsolute(rel)) {
    const rootRel = relative(root, rel);
    if (rootRel === '' || rootRel.startsWith('..') || isAbsolute(rootRel)) return null;
    relPath = rootRel;
  }

  const abs = resolve(root, relPath);
  const r = relative(root, abs);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;

  const segs = r.split(/[/\\]/);
  const matches = ALLOWED_PREFIXES.some((prefix) => {
    if (segs.length < prefix.length) return false;
    return prefix.every((seg, i) => segs[i] === seg);
  });
  if (!matches) return null;

  return abs;
}
