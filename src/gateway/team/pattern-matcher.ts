/** @desc gitignore-style pattern matcher for .include-pack — supports !-negation, glob, last-match-wins */

export interface ParsedPattern {
  raw: string;     // original pattern text (post-trim, without `!` prefix if negated)
  negate: boolean; // true if line starts with `!`
  regex: RegExp;   // anchored regex for this pattern
}

/** Convert a single .include-pack line into a compiled pattern. Returns null on blanks/comments. */
export function parsePattern(raw: string): ParsedPattern | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let body = trimmed;
  const negate = body.startsWith("!");
  if (negate) body = body.slice(1);
  if (body.endsWith("/")) body = body.slice(0, -1);
  if (!body) return null;

  // Glob → regex: escape regex metas (except *, ?, /); convert ** → placeholder;
  // * → [^/]* ; ** → .* ; ? → [^/]. Anchor at ^ ; append (?:/.*)?$ so dir-like patterns
  // also match descendants.
  let r = body.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
  const Z = "\u0001";
  r = r.replace(/\*\*/g, Z);
  r = r.replace(/\*/g, "[^/]*");
  r = r.replace(new RegExp(Z, "g"), ".*");
  r = r.replace(/\?/g, "[^/]");

  return { raw: trimmed, negate, regex: new RegExp(`^${r}(?:/.*)?$`) };
}

/** Parse an ordered list of lines; preserves order; drops blanks/comments. */
export function parsePatterns(lines: string[]): ParsedPattern[] {
  const out: ParsedPattern[] = [];
  for (const line of lines) {
    const p = parsePattern(line);
    if (p) out.push(p);
  }
  return out;
}

/** Last-match-wins: each matching pattern flips the include flag. Default = excluded. */
export function isIncluded(filePath: string, patterns: ParsedPattern[]): boolean {
  let included = false;
  for (const p of patterns) {
    if (p.regex.test(filePath)) included = !p.negate;
  }
  return included;
}
