// @desc Unicode sanitizers for invalid surrogate handling and deep string cleanup

const REPLACEMENT_CHAR = "\uFFFD";

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD.
 * Valid surrogate pairs are preserved.
 *
 * Fast path: scan once. If every surrogate is half of a valid pair, return
 * the input string by reference — no allocation. The slow rebuild only kicks
 * in when an unpaired surrogate is actually found, which is rare in practice.
 * Called per text part on every prepareMessagesForModel pass (i.e. every LLM
 * turn × every message), so the hot path matters.
 */
export function sanitizeInvalidSurrogates(input: string): string {
  if (!input) return input;
  const len = input.length;
  let firstBad = -1;
  for (let i = 0; i < len; i++) {
    const code = input.charCodeAt(i);
    // Outside the surrogate range: nothing to check.
    if (code < 0xD800 || code > 0xDFFF) continue;
    if (isHighSurrogate(code) && i + 1 < len && isLowSurrogate(input.charCodeAt(i + 1))) {
      i++; // Valid pair; skip the low half.
      continue;
    }
    firstBad = i;
    break;
  }
  if (firstBad === -1) return input;

  // Slow path: copy the clean prefix once, then walk from firstBad.
  let out = input.slice(0, firstBad);
  for (let i = firstBad; i < len; i++) {
    const code = input.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 < len && isLowSurrogate(input.charCodeAt(i + 1))) {
        out += input[i] + input[i + 1];
        i++;
        continue;
      }
      out += REPLACEMENT_CHAR;
      continue;
    }
    if (isLowSurrogate(code)) {
      out += REPLACEMENT_CHAR;
      continue;
    }
    out += input[i];
  }
  return out;
}

/**
 * Recursively sanitize all string leaves in objects/arrays.
 * Non-string primitive values are returned as-is.
 */
export function sanitizeUnknownStrings<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeInvalidSurrogates(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknownStrings(item)) as T;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      out[k] = sanitizeUnknownStrings(v);
    }
    return out as T;
  }
  return value;
}
