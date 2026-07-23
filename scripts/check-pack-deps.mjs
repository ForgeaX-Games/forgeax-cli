#!/usr/bin/env node
/** List bare imports in dist/ that are missing from package.json dependencies. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules, createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const deps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function walk(d, acc = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const re = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g;
const found = new Set();
const missing = new Set();
const root = join(new URL('..', import.meta.url).pathname, 'dist');

for (const f of walk(root)) {
  const s = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(s))) {
    const spec = m[1] || m[2];
    if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
    if (builtins.has(spec) || builtins.has(spec.replace(/^node:/, ''))) continue;
    const name = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    found.add(name);
    if (!deps.has(name)) missing.add(name);
  }
}

console.log('external:', [...found].sort().join(', '));
console.log('MISSING:', [...missing].sort().join(', ') || '(none)');
if (missing.size) process.exit(1);
