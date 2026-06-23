import { describe, test, expect } from 'bun:test';
import { friendlyPath } from '../src/api/lib/friendly-path';

describe('friendlyPath', () => {
  test('rewrites $HOME + / prefix to ~', () => {
    expect(friendlyPath('/home/you/.local/bin/claude', '/home/you')).toBe('~/.local/bin/claude');
    expect(friendlyPath('/home/you/.cargo/bin/codex', '/home/you')).toBe('~/.cargo/bin/codex');
  });

  test('leaves non-home paths untouched', () => {
    expect(friendlyPath('/usr/local/bin/claude', '/home/you')).toBe('/usr/local/bin/claude');
    expect(friendlyPath('/opt/codex/bin/codex', '/home/you')).toBe('/opt/codex/bin/codex');
  });

  test('refuses partial-prefix false positives (no trailing /)', () => {
    // $HOME=/home/you; path=/home/you/bin → must NOT match
    expect(friendlyPath('/home/you/bin', '/home/you')).toBe('/home/you/bin');
  });

  test('returns input untouched when $HOME is empty/undefined', () => {
    expect(friendlyPath('/home/you/bin/claude', '')).toBe('/home/you/bin/claude');
    expect(friendlyPath('/home/you/bin/claude', undefined)).toBe('/home/you/bin/claude');
  });

  test('exact home-only path → ~ (edge: no trailing slash in input)', () => {
    // $HOME=/home/you; path=/home/you → no startsWith('/home/you/') match;
    // we deliberately don't rewrite bare $HOME (defensive: would render "~"
    // for a directory probably not what the caller wants).
    expect(friendlyPath('/home/you', '/home/you')).toBe('/home/you');
  });

  test('home with trailing slash is normalized (tick 266)', () => {
    // Some users set HOME='/home/you/' (with trailing slash) in .bashrc.
    // Without normalization, home + '/' = '/home/you//' which never matches
    // any real path → redaction silently failed for these users.
    expect(friendlyPath('/home/you/.local/bin/claude', '/home/you/')).toBe('~/.local/bin/claude');
    expect(friendlyPath('/home/you/.cargo/bin/codex', '/home/you/')).toBe('~/.cargo/bin/codex');
  });
});
