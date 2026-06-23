import { describe, test, expect } from 'bun:test';
import { GAME_SLUG_RE } from '../src/api/workbench';

// Locks the workbench game-slug validation regex used by both
// POST /api/workbench/games (create) and DELETE /api/workbench/games/:slug.
// Slugs become both filesystem dirs (`.forgeax/games/<slug>/`) and engine
// query params (`/preview/?slug=<x>`) — picky about URL/path-safe chars
// + lowercase to keep case-sensitivity gotchas off the table.
//
// projects.ts intentionally allows underscores at the workspace level;
// games are stricter (no _). If you change either, lock that decision
// here so it can't drift silently.

describe('GAME_SLUG_RE — accepts valid slugs', () => {
  test('simple lowercase', () => {
    expect(GAME_SLUG_RE.test('snake')).toBe(true);
    expect(GAME_SLUG_RE.test('spin-cube')).toBe(true);
    expect(GAME_SLUG_RE.test('tick14-ui-probe')).toBe(true);
  });

  test('digit-prefixed (must be alnum first, then [a-z0-9-]*)', () => {
    expect(GAME_SLUG_RE.test('2048')).toBe(true);
    expect(GAME_SLUG_RE.test('3d-pong')).toBe(true);
  });

  test('boundary length (2 chars min, 41 chars max)', () => {
    expect(GAME_SLUG_RE.test('a' + 'b')).toBe(true); // 2 chars
    expect(GAME_SLUG_RE.test('a' + 'b'.repeat(40))).toBe(true); // 41 chars
  });
});

describe('GAME_SLUG_RE — rejects invalid slugs', () => {
  test('empty / single-char (below 2-char floor)', () => {
    expect(GAME_SLUG_RE.test('')).toBe(false);
    expect(GAME_SLUG_RE.test('a')).toBe(false);
  });

  test('uppercase (slugs are case-folded by convention)', () => {
    expect(GAME_SLUG_RE.test('Snake')).toBe(false);
    expect(GAME_SLUG_RE.test('UPPER')).toBe(false);
  });

  test('underscore (intentionally stricter than projects.ts)', () => {
    expect(GAME_SLUG_RE.test('snake_game')).toBe(false);
    expect(GAME_SLUG_RE.test('_template')).toBe(false); // also catches the reserved underscore-prefix scaffold dir
  });

  test('whitespace + URL-unsafe chars', () => {
    expect(GAME_SLUG_RE.test('snake game')).toBe(false);
    expect(GAME_SLUG_RE.test('snake/3d')).toBe(false);
    expect(GAME_SLUG_RE.test('snake.3d')).toBe(false);
  });

  test('unicode / CJK (filesystem-safe but not URL-stable across encodings)', () => {
    expect(GAME_SLUG_RE.test('贪吃蛇')).toBe(false);
    expect(GAME_SLUG_RE.test('café')).toBe(false);
  });

  test('over-length (>41 chars)', () => {
    expect(GAME_SLUG_RE.test('a' + 'b'.repeat(41))).toBe(false); // 42 chars
  });

  test('leading hyphen (first char must be alnum)', () => {
    expect(GAME_SLUG_RE.test('-snake')).toBe(false);
  });
});
