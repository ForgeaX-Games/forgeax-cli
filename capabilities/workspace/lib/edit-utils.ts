/**
 * Core string matching and replacement utilities for file editing tools.
 * Ported from Claude Code's FileEditTool/utils.ts — provides safe replacement
 * (immune to JS `$` special patterns), quote normalization fallback, and
 * trailing-whitespace stripping.
 */

const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
const LEFT_DOUBLE_CURLY_QUOTE = "\u201c";
const RIGHT_DOUBLE_CURLY_QUOTE = "\u201d";

// ── Width normalization (fullwidth → halfwidth) ────────────────────

/** CJK punctuation outside the FF01-FF5E fullwidth ASCII block. */
const CJK_PUNCT_MAP: Record<string, string> = {
  "\u3002": ".", // 。→ .
  "\u3001": ",", // 、→ ,
};

/**
 * Normalize fullwidth characters to halfwidth equivalents.
 * Covers the FF01-FF5E fullwidth ASCII block (offset 0xFEE0) plus
 * a small set of CJK-specific punctuation (。→ . , 、→ ,).
 */
export function normalizeWidthChars(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // FF01 (！) through FF5E (～) — fullwidth ASCII
    if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCharCode(code - 0xfee0);
    } else {
      const ch = str[i]!;
      result += CJK_PUNCT_MAP[ch] ?? ch;
    }
  }
  return result;
}

// ── Quote normalization ─────────────────────────────────────────────

export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/** Combined normalization: quotes + fullwidth→halfwidth in one pass. */
function normalizeAll(str: string): string {
  return normalizeWidthChars(normalizeQuotes(str));
}

// ── Find actual string (exact → quote → width fallback) ─────────────

export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // 1. Exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // 2. Quote normalization only (curly ↔ straight)
  const qSearch = normalizeQuotes(searchString);
  const qFile = normalizeQuotes(fileContent);
  const qIdx = qFile.indexOf(qSearch);
  if (qIdx !== -1) {
    return fileContent.substring(qIdx, qIdx + searchString.length);
  }

  // 3. Full normalization (quotes + fullwidth/halfwidth)
  const nSearch = normalizeAll(searchString);
  const nFile = normalizeAll(fileContent);
  const nIdx = nFile.indexOf(nSearch);
  if (nIdx !== -1) {
    return fileContent.substring(nIdx, nIdx + searchString.length);
  }

  return null;
}

// ── Preserve quote style ────────────────────────────────────────────

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "\u2014" ||
    prev === "\u2013"
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE);
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE);
      }
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

/**
 * When old_string matched via quote normalization, apply the same curly-quote
 * style to new_string so the edit preserves the file's typography.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) return newString;

  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);
  return result;
}

// ── Strip trailing whitespace ───────────────────────────────────────

export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part !== undefined) {
      if (i % 2 === 0) {
        result += part.replace(/\s+$/, "");
      } else {
        result += part;
      }
    }
  }
  return result;
}

// ── Safe replacement (uses callback to avoid $ special patterns) ────

export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace);

  if (newString !== "") {
    return f(originalContent, oldString, newString);
  }

  const stripTrailingNewline =
    !oldString.endsWith("\n") && originalContent.includes(oldString + "\n");

  return stripTrailingNewline
    ? f(originalContent, oldString + "\n", newString)
    : f(originalContent, oldString, newString);
}
