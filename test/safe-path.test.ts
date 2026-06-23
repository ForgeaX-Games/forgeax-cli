import { describe, test, expect } from 'bun:test';
import { resolveSafePath } from '../src/api/lib/safe-path';

// resolveSafePath is the single chokepoint guarding every /api/files
// (read + write) call. Tick 367 pen-tested it live across 6 patterns;
// this suite locks the contract at the unit tier so a future refactor
// can't quietly weaken whitelist enforcement.

const ROOT = '/proj';

describe('resolveSafePath — security guard', () => {
  test('valid in-whitelist path resolves', () => {
    expect(resolveSafePath(ROOT, 'games/spinning-cube/src/main.ts')).toBe(
      '/proj/games/spinning-cube/src/main.ts',
    );
    expect(resolveSafePath(ROOT, 'packages/server/package.json')).toBe(
      '/proj/packages/server/package.json',
    );
  });

  test.each([
    { name: 'empty', input: '' },
    { name: 'non-string null', input: null as unknown as string },
    { name: 'non-string number', input: 42 as unknown as string },
    { name: 'null byte injection', input: 'games/foo\0/bar.txt' },
  ])('rejects $name input → null', ({ input }) => {
    expect(resolveSafePath(ROOT, input)).toBeNull();
  });

  test.each([
    'absolute /etc/passwd',
    'dot-dot ../../etc/passwd',
    'dot-dot after prefix games/../../etc/passwd',
    'top-level not whitelisted secrets/key.json',
    'whitelist look-alike gamesx/foo',
    'deep climb games/spinning-cube/../../../etc/passwd',
  ])('rejects %s → null', (caseDesc) => {
    const map: Record<string, string> = {
      'absolute /etc/passwd': '/etc/passwd',
      'dot-dot ../../etc/passwd': '../../etc/passwd',
      'dot-dot after prefix games/../../etc/passwd': 'games/../../etc/passwd',
      'top-level not whitelisted secrets/key.json': 'secrets/key.json',
      'whitelist look-alike gamesx/foo': 'gamesx/foo',
      'deep climb games/spinning-cube/../../../etc/passwd':
        'games/spinning-cube/../../../etc/passwd',
    };
    expect(resolveSafePath(ROOT, map[caseDesc])).toBeNull();
  });

  test('root itself ("") is rejected even though it resolves under root', () => {
    // r === '' branch — explicit edge case.
    expect(resolveSafePath(ROOT, '')).toBeNull();
  });
});
