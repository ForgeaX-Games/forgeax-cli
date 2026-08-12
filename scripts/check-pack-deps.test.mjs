import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-pack-deps.mjs');

test('resolves the dist root through the platform filesystem URL conversion', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/u);
  assert.doesNotMatch(source, /new URL\('\.\.', import\.meta\.url\)\.pathname/u);
});
