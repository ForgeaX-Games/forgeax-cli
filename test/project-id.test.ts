import { describe, test, expect } from 'bun:test';
import { PROJECT_ID_RE } from '../src/api/projects';
import { GAME_SLUG_RE } from '../src/api/workbench';

// Locks /^[a-z0-9][a-z0-9-_]{1,40}$/ used by POST /api/projects and
// DELETE /api/projects/:id. Workspace ids = sibling filesystem dirs;
// no engine URL ever embeds them so underscores are fine (unlike
// GAME_SLUG_RE which feeds /preview/?slug=<x>).
//
// One cross-check at the end asserts the asymmetry stays intentional —
// removing underscore from PROJECT_ID_RE without removing it from this
// asymmetry test would force a maintainer to think before they tighten.

describe('PROJECT_ID_RE — accepts valid workspace ids', () => {
  test('simple lowercase', () => {
    expect(PROJECT_ID_RE.test('forgeax-studio')).toBe(true);
    expect(PROJECT_ID_RE.test('arena')).toBe(true);
  });

  test('digit-prefixed', () => {
    expect(PROJECT_ID_RE.test('2026-experiment')).toBe(true);
    expect(PROJECT_ID_RE.test('42')).toBe(true);
  });

  test('underscore — intentionally allowed (unlike GAME_SLUG_RE)', () => {
    expect(PROJECT_ID_RE.test('snake_ws')).toBe(true);
    expect(PROJECT_ID_RE.test('my_project')).toBe(true);
  });

  test('boundary length (2 chars min, 41 chars max)', () => {
    expect(PROJECT_ID_RE.test('ab')).toBe(true);
    expect(PROJECT_ID_RE.test('a' + 'b'.repeat(40))).toBe(true);
  });
});

describe('PROJECT_ID_RE — rejects invalid workspace ids', () => {
  test('empty / single-char (below 2-char floor)', () => {
    expect(PROJECT_ID_RE.test('')).toBe(false);
    expect(PROJECT_ID_RE.test('a')).toBe(false);
  });

  test('uppercase (filesystems may be case-insensitive but ids are case-folded)', () => {
    expect(PROJECT_ID_RE.test('MyProject')).toBe(false);
  });

  test('whitespace + URL-unsafe chars', () => {
    expect(PROJECT_ID_RE.test('my project')).toBe(false);
    expect(PROJECT_ID_RE.test('my/project')).toBe(false);
    expect(PROJECT_ID_RE.test('my.project')).toBe(false);
  });

  test('unicode / CJK', () => {
    expect(PROJECT_ID_RE.test('我的项目')).toBe(false);
  });

  test('over-length (>41 chars)', () => {
    expect(PROJECT_ID_RE.test('a' + 'b'.repeat(41))).toBe(false);
  });

  test('leading underscore (first char must be alnum)', () => {
    expect(PROJECT_ID_RE.test('_template')).toBe(false);
    expect(PROJECT_ID_RE.test('_my-ws')).toBe(false);
  });
});

describe('PROJECT_ID_RE vs GAME_SLUG_RE — intentional asymmetry', () => {
  test('underscore: projects accepts, games rejects', () => {
    // If either side of this changes, the maintainer changing it should
    // update this test deliberately so it can't drift unnoticed.
    expect(PROJECT_ID_RE.test('foo_bar')).toBe(true);
    expect(GAME_SLUG_RE.test('foo_bar')).toBe(false);
  });

  test('non-underscore chars: both agree', () => {
    expect(PROJECT_ID_RE.test('foo-bar')).toBe(true);
    expect(GAME_SLUG_RE.test('foo-bar')).toBe(true);
    expect(PROJECT_ID_RE.test('FOO')).toBe(false);
    expect(GAME_SLUG_RE.test('FOO')).toBe(false);
  });
});
