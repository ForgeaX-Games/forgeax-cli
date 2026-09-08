/**
 * Bounded parser for the legacy text-form tool-call shape observed in TAPD
 * 1070160897162272877.
 *
 * This module only recognizes a complete, standalone bracket expression. It
 * does not dispatch tools and it never creates a tool_result. CoreAgent uses a
 * successful parse only to request one native-tool continuation.
 */

export const MAX_BRACKET_TOOL_TEXT_CHARS = 32_768;
export const MAX_BRACKET_TOOL_ARGS_CHARS = 16_384;
export const MAX_BRACKET_TOOL_JSON_DEPTH = 16;
export const MAX_BRACKET_TOOL_JSON_NODES = 2_048;

const TOOL_NAME_PATTERN = '[A-Za-z][A-Za-z0-9_.-]{0,127}';
const PARTIAL_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const COMPLETE_BRACKET_CALL = new RegExp(`^\\[called (${TOOL_NAME_PATTERN})\\(([\\s\\S]*)\\)\\]$`);
const PREFIX = /^\[called /;
const STANDALONE_BRACKET_PREFIX = '[called ';
const TOOL_NAME = new RegExp(`^${TOOL_NAME_PATTERN}$`);

export interface BracketPseudoToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Stable name+arguments identity used to reject repeated recovery. */
  readonly key: string;
}

export interface StandaloneBracketToolShape {
  readonly name: string;
}

function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function hasBoundedJsonShape(value: unknown, depth = 0, state = { nodes: 0 }): boolean {
  state.nodes++;
  if (state.nodes > MAX_BRACKET_TOOL_JSON_NODES || depth > MAX_BRACKET_TOOL_JSON_DEPTH) return false;
  if (!isJsonContainer(value)) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.every((child) => hasBoundedJsonShape(child, depth + 1, state));
}

/**
 * Parse only the complete standalone shape:
 * `[called <tool-name>(<JSON object>)]`.
 *
 * `null` intentionally conflates prose, incomplete text, invalid JSON, and
 * resource-limit violations. The caller must fail closed for all of them.
 */
export function parseBracketPseudoToolText(text: unknown): BracketPseudoToolCall | null {
  if (typeof text !== 'string' || text.length > MAX_BRACKET_TOOL_TEXT_CHARS) return null;
  const source = text.trim();
  if (!source || source.length > MAX_BRACKET_TOOL_TEXT_CHARS) return null;

  const match = COMPLETE_BRACKET_CALL.exec(source);
  if (!match) return null;
  const name = match[1];
  const rawArgs = match[2];
  if (!name || rawArgs.length === 0 || rawArgs.length > MAX_BRACKET_TOOL_ARGS_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!hasBoundedJsonShape(parsed)) return null;

  return {
    name,
    input: parsed as Record<string, unknown>,
    key: `${name}:${stableStringify(parsed)}`,
  };
}

/**
 * Recognize the outer standalone bracket envelope without parsing its JSON.
 * This is intentionally cheap and bounded: callers use it only to replace a
 * complete malformed/unavailable request with a safe message, never to run a
 * tool. Embedded prose is not a match.
 */
export function findStandaloneBracketToolShape(text: unknown): StandaloneBracketToolShape | null {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  if (!source.startsWith(STANDALONE_BRACKET_PREFIX) || !source.endsWith(')]')) return null;
  const nameStart = STANDALONE_BRACKET_PREFIX.length;
  const openParen = source.indexOf('(', nameStart);
  if (openParen <= nameStart) return null;
  const name = source.slice(nameStart, openParen);
  return TOOL_NAME.test(name) ? { name } : null;
}

/**
 * Return true while a streamed text block could still become the complete
 * bracket shape. We deliberately keep this lexical and bounded; final JSON
 * and roster validation happen only in parseBracketPseudoToolText().
 */
export function isPossibleBracketToolPrefix(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > MAX_BRACKET_TOOL_TEXT_CHARS) return false;
  const source = text.trimStart();
  if (!PREFIX.test(source)) return false;
  const rest = source.slice('[called '.length);
  if (rest.length === 0) return true;
  const open = rest.indexOf('(');
  if (open === -1) return PARTIAL_TOOL_NAME.test(rest);
  return new RegExp(`^${TOOL_NAME_PATTERN}$`).test(rest.slice(0, open));
}

/** Nudge text contains no bracket-call payload, so it cannot become visible history. */
export function buildBracketToolNudge(call: BracketPseudoToolCall): string {
  return (
    `<system-reminder>The previous assistant response encoded a tool request as text. ` +
    `Repeat the same request through the native tool interface: ${call.name} with JSON arguments ` +
    `${stableStringify(call.input)}. Do not print a bracketed tool call.</system-reminder>`
  );
}

export const BRACKET_TOOL_REPEAT_MESSAGE =
  'The model repeated a text-form tool request, so no tool was executed. Please retry the request.';

export const BRACKET_TOOL_REJECT_MESSAGE =
  'The model emitted an invalid or unavailable text-form tool request, so no tool was executed.';
