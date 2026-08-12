import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('pack helper invokes npm pack exactly once and emits the resolved tarball path', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-pack-release-'));
  const fakeBin = join(fixture, 'bin');
  const destination = join(fixture, 'packed artifacts');
  const invocationLog = join(fixture, 'npm-invocations.jsonl');
  const githubOutput = join(fixture, 'github-output');
  const filename = 'forgeax-cli-0.1.15.tgz';
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.PACK_RELEASE_INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const destinationIndex = process.argv.indexOf('--pack-destination');
if (destinationIndex < 0 || !process.argv[destinationIndex + 1]) process.exit(64);
const destination = process.argv[destinationIndex + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, ${JSON.stringify(filename)}), 'packed fixture');
process.stdout.write(JSON.stringify([{ filename: ${JSON.stringify(filename)} }]) + '\\n');
`,
  );
  chmodSync(fakeNpm, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/pack-release.mjs', '--destination', destination],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutput,
          PACK_RELEASE_INVOCATION_LOG: invocationLog,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const expectedTarball = resolve(destination, filename);
    assert.equal(result.stdout.trim(), expectedTarball);
    assert.equal(readFileSync(githubOutput, 'utf8'), `tarball=${expectedTarball}\n`);

    const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(invocations, [['pack', '--json', '--ignore-scripts', '--pack-destination', resolve(destination)]]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
