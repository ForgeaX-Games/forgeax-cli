#!/usr/bin/env node
/** Validate a self-contained, publishable dist/ plus its external dependencies. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = process.env.FORGEAX_PACKAGE_JSON ?? join(packageRoot, 'package.json');
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const deps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
const contractPackageNames = ['@forgeax/types', '@forgeax/agent-runtime'];
const sourceProtocols = /^(?:workspace:|file:|link:|portal:|\.\.?(?:[\\/]|$)|~[\\/]|[A-Za-z]:[\\/]|[\\/])/i;

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

function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\b[^;]*?\bfrom\s*(["'])([^"']+)\1/g,
    /\bimport\s*(["'])([^"']+)\1/g,
    /\b(?:import|require)\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) specifiers.add(match[2]);
  }
  return specifiers;
}

const found = new Set();
const missing = new Set();
const root = process.env.FORGEAX_DIST_DIR ?? join(packageRoot, 'dist');

for (const f of walk(root)) {
  const s = readFileSync(f, 'utf8');
  for (const spec of extractModuleSpecifiers(s)) {
    if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
    if (builtins.has(spec) || builtins.has(spec.replace(/^node:/, ''))) continue;
    const name = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    found.add(name);
    if (!deps.has(name)) missing.add(name);
  }
}

const manifestSources = [];
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
    if (typeof specifier === 'string' && sourceProtocols.test(specifier)) {
      manifestSources.push(`${section}.${name}=${specifier}`);
    }
  }
}

const buildInputsPath = join(root, 'build-inputs.json');
if (!existsSync(buildInputsPath)) {
  console.error('MISSING: dist/build-inputs.json');
  process.exit(1);
}
const buildInputs = JSON.parse(readFileSync(buildInputsPath, 'utf8'));
for (const name of contractPackageNames) {
  if (buildInputs[name] !== pkg.devDependencies?.[name]) {
    console.error(`INVALID build input: ${name}=${buildInputs[name] ?? '(missing)'}`);
    process.exit(1);
  }
}

const bareContractImports = [...found].filter((name) => contractPackageNames.includes(name));

console.log('external:', [...found].sort().join(', '));
console.log('MISSING:', [...missing].sort().join(', ') || '(none)');
console.log('CONTRACT_IMPORTS:', bareContractImports.sort().join(', ') || '(none)');
console.log('MANIFEST_SOURCE_PROTOCOLS:', manifestSources.join(', ') || '(none)');
if (missing.size || bareContractImports.length || manifestSources.length) process.exit(1);
