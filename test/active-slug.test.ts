import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { detectActiveSlug } from '../src/api/lib/active-slug';

// Locks the shared detectActiveSlug consumed by both api/workbench.ts and
// cli-providers/providers/claude-code.ts. Used to scope "把背景改成蓝色"
// ambiguous edits onto the most-recent .forgeax/games/<slug>/.

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'forgeax-active-slug-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(slug: string, mtime: Date) {
  const dir = resolve(root, '.forgeax/games', slug);
  mkdirSync(dir, { recursive: true });
  utimesSync(dir, mtime, mtime);
}

describe('detectActiveSlug', () => {
  test('missing .forgeax/games dir → undefined (fresh project)', () => {
    expect(detectActiveSlug(root)).toBeUndefined();
  });

  test('empty .forgeax/games dir → undefined', () => {
    mkdirSync(resolve(root, '.forgeax/games'), { recursive: true });
    expect(detectActiveSlug(root)).toBeUndefined();
  });

  test('single game → that slug', () => {
    touch('only-game', new Date(2026, 0, 1));
    expect(detectActiveSlug(root)).toBe('only-game');
  });

  test('multiple games → most-recent mtime wins', () => {
    touch('old-game', new Date(2026, 0, 1));
    touch('newer-game', new Date(2026, 0, 5));
    touch('newest-game', new Date(2026, 0, 10));
    expect(detectActiveSlug(root)).toBe('newest-game');
  });

  test('hidden + underscore entries are skipped', () => {
    touch('_template', new Date(2026, 0, 20)); // most-recent but underscore
    touch('.cache', new Date(2026, 0, 15));    // most-recent but hidden
    touch('real-game', new Date(2026, 0, 1));  // oldest but visible
    expect(detectActiveSlug(root)).toBe('real-game');
  });

  // Regression — a dangling symlink (e.g. a games/<slug> link whose target was
  // removed by a submodule sync) must NOT take out detection. The buggy
  // loop-wide try/catch let one statSync ENOENT throw out of the whole loop →
  // undefined, order-independent. The per-entry guard skips it instead.
  test('dangling symlink entry is skipped, not fatal', () => {
    mkdirSync(resolve(root, '.forgeax/games'), { recursive: true });
    symlinkSync(resolve(root, 'nonexistent-target'), resolve(root, '.forgeax/games/broken'));
    touch('real-game', new Date(2026, 0, 1));
    expect(detectActiveSlug(root)).toBe('real-game');
  });
});
