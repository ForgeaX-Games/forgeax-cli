#!/usr/bin/env node
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseDestination(argv) {
  if (argv.length !== 2 || argv[0] !== '--destination' || !argv[1]) {
    throw new Error('Usage: node scripts/pack-release.mjs --destination <directory>');
  }
  return resolve(argv[1]);
}

function main() {
  const destination = parseDestination(process.argv.slice(2));
  mkdirSync(destination, { recursive: true });

  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `npm pack exited ${result.status}`).trim());
  }

  const packed = JSON.parse(result.stdout);
  const filename = packed?.[0]?.filename;
  if (!Array.isArray(packed) || packed.length !== 1 || typeof filename !== 'string') {
    throw new Error('npm pack did not produce exactly one tarball.');
  }
  if (basename(filename) !== filename || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack returned an invalid tarball filename: ${filename}`);
  }

  const tarball = resolve(destination, filename);
  if (!statSync(tarball).isFile()) throw new Error(`npm pack tarball is missing: ${tarball}`);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
  process.stdout.write(`${tarball}\n`);
}

try {
  main();
} catch (error) {
  console.error(`pack-release failed: ${error.message}`);
  process.exit(1);
}
