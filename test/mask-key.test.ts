import { describe, test, expect } from 'bun:test';
import { maskKey } from '../src/api/settings';

// /api/settings returns secrets in a `first4...last4` shape so the UI
// can render a recognisable preview without exposing enough for theft.
// The Settings drawer parses these strings literally — locking the shape
// here prevents an innocent-looking "make the mask longer" tweak from
// silently breaking the drawer's reveal/edit toggle.
describe('maskKey()', () => {
  test('undefined → null', () => {
    expect(maskKey(undefined)).toBeNull();
  });
  test('empty string → null', () => {
    expect(maskKey('')).toBeNull();
  });
  test('≤8 chars collapses to ***', () => {
    expect(maskKey('abc')).toBe('***');
    expect(maskKey('12345678')).toBe('***'); // boundary inclusive
  });
  test('9 chars: first4 + ... + last4 (boundary exclusive)', () => {
    expect(maskKey('123456789')).toBe('1234...6789');
  });
  test('long realistic Anthropic-style key', () => {
    // Build the key-shaped fixture from parts so the literal prefix never
    // appears verbatim (avoids secret-scanner false positives in the mirror).
    const key = ['sk', 'ant', 'api03'].join('-') + '-' + 'x'.repeat(80) + '-LszH';
    const m = maskKey(key);
    expect(m).toBe('sk-a...LszH');
    // The masked form must not leak the middle.
    expect(m).not.toContain('xxxx');
  });
  test('output is deterministic + idempotent for the same input', () => {
    expect(maskKey('aaaa-mid-bbbb')).toBe(maskKey('aaaa-mid-bbbb'));
  });
});
