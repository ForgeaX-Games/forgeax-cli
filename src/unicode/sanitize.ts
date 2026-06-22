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
 */
export function sanitizeInvalidSurrogates(input: string): string {
  if (!input) return input;
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);
        if (isLowSurrogate(next)) {
          out += input[i] + input[i + 1];
          i++;
          continue;
        }
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
