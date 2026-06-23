/** Core string matching and replacement utilities for file editing tools.
 *
 *  Ported from agenteam-os ref `capabilities/workspace/lib/edit-utils.ts`，
 *  逻辑完全等价：
 *  - findActualString：精确 → 引号规范化 → 全宽半宽规范化 三段 fallback
 *  - applyEditToFile：用 callback 形式 .replace 避免 `$` 特殊语义
 *  - preserveQuoteStyle：匹配到非精确 old 时，让 new_string 保留原文件的引号风格 */

const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
const LEFT_DOUBLE_CURLY_QUOTE = "\u201c";
const RIGHT_DOUBLE_CURLY_QUOTE = "\u201d";

const CJK_PUNCT_MAP: Record<string, string> = {
  "\u3002": ".",
  "\u3001": ",",
};

export function normalizeWidthChars(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCharCode(code - 0xfee0);
    } else {
      const ch = str[i]!;
      result += CJK_PUNCT_MAP[ch] ?? ch;
    }
  }
  return result;
}

export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function normalizeAll(str: string): string {
  return normalizeWidthChars(normalizeQuotes(str));
}

export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const qSearch = normalizeQuotes(searchString);
  const qFile = normalizeQuotes(fileContent);
  const qIdx = qFile.indexOf(qSearch);
  if (qIdx !== -1) return fileContent.substring(qIdx, qIdx + searchString.length);

  const nSearch = normalizeAll(searchString);
  const nFile = normalizeAll(fileContent);
  const nIdx = nFile.indexOf(nSearch);
  if (nIdx !== -1) return fileContent.substring(nIdx, nIdx + searchString.length);

  return null;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === " " || prev === "\t" || prev === "\n" || prev === "\r" ||
    prev === "(" || prev === "[" || prev === "{" ||
    prev === "\u2014" || prev === "\u2013"
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

export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part !== undefined) {
      if (i % 2 === 0) result += part.replace(/\s+$/, "");
      else result += part;
    }
  }
  return result;
}

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

  if (newString !== "") return f(originalContent, oldString, newString);

  const stripTrailingNewline =
    !oldString.endsWith("\n") && originalContent.includes(oldString + "\n");

  return stripTrailingNewline
    ? f(originalContent, oldString + "\n", newString)
    : f(originalContent, oldString, newString);
}
