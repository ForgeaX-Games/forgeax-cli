import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { composeReincarnationNotice, composeEpisodicRecall } from '../src/soul/layered-memory';

let root = '';
const ep = (game: string, name: string, body: string) => {
  const d = join(root, 'episodes', game);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), body);
};
const trait = (name: string, body: string) => {
  const d = join(root, 'traits');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), body);
};

beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), 'fxsoul-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

test('no game → no notice', () => {
  expect(composeReincarnationNotice({ root })).toBe('');
});

test('newborn (no episodes anywhere) → no notice', () => {
  trait('curious.md', '# curious\nI ask a lot.');
  expect(composeReincarnationNotice({ root, game: 'space-rts' })).toBe('');
});

test('past-life soul entering a NEW world → reincarnation notice (lists past worlds, not current)', () => {
  ep('platformer', 'jump.md', '# jump tuning\ngravity felt good at 9.8');
  ep('puzzle', 'grid.md', '# grid\n8x8 worked');
  const out = composeReincarnationNotice({ root, game: 'space-rts' });
  expect(out).toContain('Reincarnation');
  expect(out).toContain('space-rts');
  expect(out).toContain('`platformer`');
  expect(out).toContain('`puzzle`');
  expect(out).toContain('memory_search');
  // current world must NOT be listed as a past life
  expect(out).not.toContain('- `space-rts`');
});

test('returning to a world it has lived in → NO notice (episodic recall takes over)', () => {
  ep('platformer', 'jump.md', '# jump tuning\ngravity 9.8');
  ep('space-rts', 'fleet.md', '# fleet\nbalance pass 1');
  expect(composeReincarnationNotice({ root, game: 'space-rts' })).toBe('');
  // and episodic recall DOES fire for the lived-in world
  expect(composeEpisodicRecall({ root, game: 'space-rts' })).toContain('this world (space-rts)');
});

test('mutually exclusive: notice XOR episodic for any single (root,game)', () => {
  ep('platformer', 'a.md', '# a\nx');
  for (const game of ['platformer', 'brand-new', 'puzzle']) {
    const notice = composeReincarnationNotice({ root, game });
    const recall = composeEpisodicRecall({ root, game });
    expect(Boolean(notice) && Boolean(recall)).toBe(false); // never both
  }
});
