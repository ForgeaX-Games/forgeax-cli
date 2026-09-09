import { expect, test } from 'bun:test';
import { configuredContextWindowForModel, contextWindowForModel } from '../src/context/model-window';

test('only the exact model receives its explicitly configured capacity', () => {
  const windows = { primary: 512000, backup: 64000, child: 96000 };
  expect(configuredContextWindowForModel('primary', windows)).toBe(512000);
  expect(configuredContextWindowForModel('backup', windows)).toBe(64000);
  expect(configuredContextWindowForModel('child', windows)).toBe(96000);
  expect(configuredContextWindowForModel('unknown-fork', windows)).toBeUndefined();
  expect(configuredContextWindowForModel(undefined, windows)).toBeUndefined();
  expect(configuredContextWindowForModel('primary')).toBeUndefined();
});

test('invalid or inherited capacities leave the existing fallback untouched', () => {
  for (const capacity of [0, -1, NaN, Infinity, 12.5, Number.MAX_SAFE_INTEGER + 1, '512000']) {
    expect(configuredContextWindowForModel('m', { m: capacity })).toBeUndefined();
  }
  for (const malformed of [null, '512000', 512000, [], true]) {
    expect(configuredContextWindowForModel('m', malformed)).toBeUndefined();
  }
  expect(configuredContextWindowForModel('m', Object.create({ m: 512000 }))).toBeUndefined();
  expect(contextWindowForModel('unknown')).toBe(200000);
});
