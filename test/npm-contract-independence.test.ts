import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import packageJson from '../package.json';
import tsconfig from '../tsconfig.json';

const ROOT = resolve(import.meta.dir, '..');
const RELEASE_WORKFLOW = join(ROOT, '.github/workflows/publish.yml');
const TRUFFLEHOG_IMAGE =
  'trufflesecurity/trufflehog:3.96.0@sha256:aa821cf4ace8861c7d096d83818cdf7bb9719028a52d37a52eaad44086a52577';
const CANONICAL_RELEASE_FILES = [
  ['scripts/check-release-secrets.mjs', '7dfd1dcd524e2010feccdb2d8c3612b35c0e90e0f9f31e42c347bf53a2c38f34'],
  ['scripts/check-release-secrets.test.mjs', '6606fa164929734141f6d9e46228824ecc32848cd746b8f849fee660e65fe432'],
  ['scripts/run-trufflehog-release-scan.sh', '9f38efbdc686657310d12fad304cac09b5398d918eaeec1b0be0ba784664bc89'],
  ['scripts/run-trufflehog-release-scan.test.mjs', '4a1a4abbdec4791a5839c9e466d892154cbd368e6bf267c06eddf5952a096160'],
  ['scripts/verify-release-artifact.py', '916e565aa2ea8e7de7619c0081a043dca5eb588f5d8d9f2bfe755624ca78fb3f'],
  ['scripts/verify-release-artifact.test.py', '891d128928e341e5eaa1dd3607c57a0bb4fd4b1c02f6f316017e19d5110ea47f'],
] as const;
const TRACKED_BUILD_CONFIG = new Set([
  '.dependency-cruiser.cjs',
  '.gitignore',
  '.npmrc',
  'build.mjs',
  'bunfig.toml',
  'package.json',
  'tsconfig.json',
]);

function relevantTrackedFiles(): string[] {
  const result = Bun.spawnSync({ cmd: ['git', 'ls-files', '-z'], cwd: ROOT });
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  return Buffer.from(result.stdout)
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter(
      (file) =>
        file.startsWith('src/') ||
        file.startsWith('scripts/') ||
        file.startsWith('.github/workflows/') ||
        TRACKED_BUILD_CONFIG.has(file) ||
        /^tsconfig(?:\.[^.]+)?\.json$/.test(file),
    );
}

function emittedJavaScript(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith('.js')) files.push(path);
    }
  };

  visit(directory);
  return files.map((file) => readFileSync(file, 'utf8'));
}

function writeBuildInputs(dist: string): void {
  writeFileSync(
    join(dist, 'build-inputs.json'),
    `${JSON.stringify({
      '@forgeax/types': '0.1.1',
      '@forgeax/agent-runtime': '0.1.1',
    })}\n`,
  );
}

function runPackGate(dist: string, packageJsonPath?: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ['node', 'scripts/check-pack-deps.mjs'],
    cwd: ROOT,
    env: {
      ...process.env,
      FORGEAX_DIST_DIR: dist,
      ...(packageJsonPath ? { FORGEAX_PACKAGE_JSON: packageJsonPath } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function processOutput(result: ReturnType<typeof Bun.spawnSync>): string {
  return Buffer.concat([
    result.stdout ?? new Uint8Array(),
    result.stderr ?? new Uint8Array(),
  ]).toString();
}

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
};

function releaseWorkflow(): { on: Record<string, unknown>; jobs: Record<string, { needs?: string; steps: WorkflowStep[] }> } {
  return Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, 'utf8')) as {
    on: Record<string, unknown>;
    jobs: Record<string, { needs?: string; steps: WorkflowStep[] }>;
  };
}

function releaseStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `missing release step: ${name}`).toBeDefined();
  return step!;
}

function releaseStepIndex(steps: WorkflowStep[], name: string): number {
  const index = steps.findIndex((candidate) => candidate.name === name);
  expect(index, `missing release step: ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function releaseCommand(args: string[], env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ['node', 'scripts/publish.mjs', ...args],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function hasObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasObjectKey(entry, key));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key) || Object.values(record).some((entry) => hasObjectKey(entry, key));
}

function writePublishingFakes(fixture: string): { fakeBin: string; realNpm: string } {
  const fakeBin = join(fixture, 'bin');
  const realNpm = Buffer.from(Bun.spawnSync({ cmd: ['which', 'npm'], stdout: 'pipe' }).stdout).toString().trim();
  mkdirSync(fakeBin);
  writeExecutable(
    join(fakeBin, 'npm'),
    `#!/usr/bin/env bash\nprintf 'npm %s\\n' "$*" >> "$RELEASE_HELPER_LOG"\ncase "$1" in\n  view) printf '%s\\n' "$RELEASE_HELPER_REMOTE_VERSION" ;;\n  whoami) printf 'release-tester\\n' ;;\n  pack) exec "$REAL_NPM" "$@" ;;\n  publish) exit 0 ;;\n  *) exit 64 ;;\nesac\n`,
  );
  writeExecutable(
    join(fakeBin, 'docker'),
    '#!/usr/bin/env bash\nprintf "docker %s\\n" "$*" >> "$RELEASE_HELPER_LOG"\nexit 0\n',
  );
  return { fakeBin, realNpm };
}

test('release scanner files have the canonical cross-repository identities', () => {
  // This catches scanner drift without making the CLI workflow depend on a Contracts checkout.
  for (const [relativePath, expectedSha256] of CANONICAL_RELEASE_FILES) {
    const actualSha256 = createHash('sha256').update(readFileSync(join(ROOT, relativePath))).digest('hex');
    expect(actualSha256, relativePath).toBe(expectedSha256);
  }
});

test('release workflow scans the standalone CLI artifact before a final token-scoped publish', () => {
  const workflow = releaseWorkflow();
  expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
  expect(workflow.on.push).toEqual({ tags: ['v*'] });
  expect(workflow.on.workflow_dispatch).toBeNull();

  expect(workflow.jobs.scan.needs).toBe('build');
  expect(workflow.jobs.publish.needs).toBe('scan');
  const buildSteps = workflow.jobs.build.steps;
  const scanSteps = workflow.jobs.scan.steps;
  const publishSteps = workflow.jobs.publish.steps;
  const buildCommands = buildSteps.flatMap((step) => (step.run ? [step.run] : []));
  expect(buildCommands.join('\n')).toContain('bun install --frozen-lockfile --ignore-scripts');
  for (const command of ['bun run typecheck', 'bun run check:boundaries', 'bun run lint:boundaries', 'bun run build', 'bun run check:pack-deps']) {
    expect(buildCommands.join('\n')).toContain(command);
  }
  expect(buildCommands.join('\n')).not.toMatch(/bun run test(?:\s|$)/);
  expect(buildCommands.filter((command) => command.includes('scripts/pack-release.mjs'))).toHaveLength(1);
  expect(scanSteps.some((step) => step.run?.includes('verify-release-artifact.py'))).toBe(true);
  expect(scanSteps.some((step) => step.run?.includes('--mode package'))).toBe(true);
  expect(publishSteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
  expect(publishSteps.some((step) => step.run?.includes('npm publish "$tarball" --access public --ignore-scripts'))).toBe(true);
  expect(JSON.stringify(workflow).match(/NPM_TOKEN/gu)).toHaveLength(1);
  expect(hasObjectKey(workflow, 'continue-on-error')).toBe(false);

  const workflowValues = JSON.stringify(workflow);
  for (const forbiddenValue of ['forgeax-studio', 'FORGEAX_STUDIO_ROOT', '../../contracts', 'studio/contracts']) {
    expect(workflowValues.toLowerCase()).not.toContain(forbiddenValue.toLowerCase());
  }
  expect(TRUFFLEHOG_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/u);
});

test('release dry-run retains only its literal environment allowlist with network and spawning denied', () => {
  // This catches any ambient-environment inheritance, network API use, spawned gate, or manifest mutation.
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-cli-release-dry-'));
  const preload = join(fixture, 'deny-release-side-effects.cjs');
  const packagePath = join(ROOT, 'package.json');
  const packageBefore = readFileSync(packagePath, 'utf8');
  const mtimeBefore = statSync(packagePath).mtimeMs;
  const currentVersion = JSON.parse(packageBefore).version as string;
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  const canaries = {
    GITLAB_PAT: 'CANARY_GITLAB_PAT',
    CI_JOB_JWT: 'CANARY_CI_JOB_JWT',
    GOOGLE_APPLICATION_CREDENTIALS: 'CANARY_GOOGLE_APPLICATION_CREDENTIALS',
    AWS_SHARED_CREDENTIALS_FILE: 'CANARY_AWS_SHARED_CREDENTIALS_FILE',
    DATABASE_URL: 'CANARY_DATABASE_URL',
    NODE_AUTH_TOKEN: 'CANARY_NODE_AUTH_TOKEN',
    ARBITRARY_CREDENTIAL_CANARY: 'CANARY_ARBITRARY_CREDENTIAL',
    INNOCUOUS_AMBIENT_VALUE: 'CANARY_INNOCUOUS_AMBIENT',
  };
  writeFileSync(
    preload,
    `const { syncBuiltinESMExports } = require('node:module');
const blocked = (capability) => () => { throw new Error('release:dry attempted ' + capability); };
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked('child_process.' + name);
const net = require('node:net');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
net.Socket.prototype.connect = blocked('net.Socket.connect');
const tls = require('node:tls');
tls.connect = blocked('tls.connect');
for (const moduleName of ['node:http', 'node:https']) {
  const transport = require(moduleName);
  transport.request = blocked(moduleName + '.request');
  transport.get = blocked(moduleName + '.get');
}
const dns = require('node:dns');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) dns[name] = blocked('dns.' + name);
require('node:dgram').createSocket = blocked('dgram.createSocket');
globalThis.fetch = blocked('fetch');
syncBuiltinESMExports();
const expectedEnvironmentKeys = new Set(['FORCE_COLOR', 'LANG', 'LC_ALL', 'NO_COLOR', 'TERM', 'TZ']);
process.on('beforeExit', () => {
  const unexpected = Object.keys(process.env).filter((key) => !expectedEnvironmentKeys.has(key));
  if (unexpected.length > 0) {
    console.error('release:dry unexpected environment keys: ' + unexpected.sort().join(','));
    process.exitCode = 96;
  }
});
`,
  );

  try {
    const result = releaseCommand(['--dry-run', '--yes', '--skip-smoke'], {
      ...canaries,
      FORCE_COLOR: '0',
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      TERM: 'dumb',
      TZ: 'UTC',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
    });
    const output = processOutput(result);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain(`Version: ${currentVersion} → ${nextVersion}`);
    expect(output).toContain('Mode: dry-run (local preview; no build, network, credentials, or mutation)');
    expect(output).not.toContain('[build] @forgeax/cli');
    expect(output).not.toContain('CONTRACT_IMPORTS:');
    for (const canary of Object.values(canaries)) expect(output).not.toContain(canary);
    expect(readFileSync(packagePath, 'utf8')).toBe(packageBefore);
    expect(statSync(packagePath).mtimeMs).toBe(mtimeBefore);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('release helper packs, scans, and publishes the exact tarball', () => {
  // This catches a publish bypass that sends npm a fresh or unscanned package instead of the checked artifact.
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-cli-release-publish-'));
  const commandLog = join(fixture, 'commands.log');
  const packagePath = join(ROOT, 'package.json');
  const packageBefore = readFileSync(packagePath, 'utf8');
  const currentVersion = JSON.parse(packageBefore).version as string;
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const targetVersion = `${major}.${minor}.${patch + 1}`;
  const { fakeBin, realNpm } = writePublishingFakes(fixture);

  try {
    const result = releaseCommand(['--set', targetVersion, '--yes', '--skip-smoke'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      REAL_NPM: realNpm,
      RELEASE_HELPER_LOG: commandLog,
      RELEASE_HELPER_REMOTE_VERSION: currentVersion,
      npm_config_cache: join(fixture, 'npm-cache'),
    });
    expect(result.exitCode, processOutput(result)).toBe(0);

    const commands = readFileSync(commandLog, 'utf8').trim().split('\n');
    const packIndex = commands.findIndex((command) => command.startsWith('npm pack --json --pack-destination '));
    const tarballScanIndex = commands.findIndex(
      (command) => command.startsWith('docker run ') && command.includes('forgeax-publish-unpack'),
    );
    const publishIndex = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(tarballScanIndex).toBeGreaterThan(packIndex);
    expect(publishIndex).toBeGreaterThan(tarballScanIndex);
    expect(commands[publishIndex]).toMatch(/npm publish \/.*\.tgz --access public --registry https:\/\/registry\.npmjs\.org\//u);
  } finally {
    writeFileSync(packagePath, packageBefore);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('release helper blocks a scanner-detectable packed artifact before publish', () => {
  // This catches a release path that scans source or a different artifact but publishes the contaminated tarball.
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-cli-release-secret-'));
  const commandLog = join(fixture, 'commands.log');
  const packagePath = join(ROOT, 'package.json');
  const readmePath = join(ROOT, 'README.md');
  const packageBefore = readFileSync(packagePath, 'utf8');
  const readmeBefore = readFileSync(readmePath, 'utf8');
  const currentVersion = JSON.parse(packageBefore).version as string;
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const targetVersion = `${major}.${minor}.${patch + 1}`;
  const { fakeBin, realNpm } = writePublishingFakes(fixture);
  writeFileSync(readmePath, `${readmeBefore}\nrelease fixture: npm_${'A'.repeat(36)}\n`);

  try {
    const result = releaseCommand(['--set', targetVersion, '--yes', '--skip-smoke'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      REAL_NPM: realNpm,
      RELEASE_HELPER_LOG: commandLog,
      RELEASE_HELPER_REMOTE_VERSION: currentVersion,
      npm_config_cache: join(fixture, 'npm-cache'),
      npm_config_offline: 'true',
    });
    const output = processOutput(result);
    expect(result.exitCode, output).toBe(1);
    expect(output).toContain('release secret scan blocked: npm-token at README.md');

    const commands = readFileSync(commandLog, 'utf8').trim().split('\n');
    expect(commands.filter((command) => command.startsWith('npm pack '))).toHaveLength(1);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  } finally {
    writeFileSync(packagePath, packageBefore);
    writeFileSync(readmePath, readmeBefore);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('build consumes the exact published Contracts packages without Studio source paths', () => {
  // This catches a resolver regression that sends CLI back to the Studio checkout.
  expect(packageJson.devDependencies['@forgeax/types']).toBe('0.1.1');
  expect(packageJson.devDependencies['@forgeax/agent-runtime']).toBe('0.1.1');
  expect(JSON.stringify(tsconfig)).not.toContain(`../..${'/contracts'}`);

  const forbiddenSourcePaths = [
    /(?:\.\.[\\/])+contracts[\\/](?:types|agent-runtime)(?:[\\/]src)?/,
    /(?:[A-Za-z]:[\\/]|\/)[^'"`\r\n]*forgeax-studio[\\/][^'"`\r\n]*contracts[\\/](?:types|agent-runtime)/,
  ];
  const violations = relevantTrackedFiles().flatMap((file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    return forbiddenSourcePaths.some((pattern) => pattern.test(text)) ? [file] : [];
  });
  expect(violations).toEqual([]);
});

test('pack gate rejects every static, side-effect, dynamic, and CommonJS Contracts import form', () => {
  const fixtures = [
    ['static import', `import { x }\n  from "@forgeax/types";`, '@forgeax/types'],
    ['re-export', `export {\n  x\n}\nfrom '@forgeax/agent-runtime/contract';`, '@forgeax/agent-runtime'],
    ['side-effect import', `import\n  '@forgeax/types/shell-split';`, '@forgeax/types'],
    ['dynamic import', `await import(\n  "@forgeax/agent-runtime/driver"\n);`, '@forgeax/agent-runtime'],
    ['CommonJS require', `require (\n  '@forgeax/types/permission-rules'\n);`, '@forgeax/types'],
  ] as const;

  for (const [name, source, packageName] of fixtures) {
    const dist = mkdtempSync(join(tmpdir(), 'forgeax-cli-pack-gate-import-'));
    try {
      writeBuildInputs(dist);
      writeFileSync(join(dist, 'fixture.js'), `${source}\n`);
      const result = runPackGate(dist);
      const output = processOutput(result);
      expect(result.exitCode, `${name}: ${output}`).toBe(1);
      expect(output, name).toContain(`CONTRACT_IMPORTS: ${packageName}`);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }
});

test('pack gate rejects local dependency protocols including portal', () => {
  const localSpecifiers = [
    'workspace:*',
    'file:../fixture',
    'link:../fixture',
    'portal:../fixture',
    '../fixture',
    '/private/tmp/fixture',
    'C:\\fixture',
  ];

  for (const specifier of localSpecifiers) {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-cli-pack-gate-manifest-'));
    const dist = join(fixture, 'dist');
    try {
      mkdirSync(dist);
      writeBuildInputs(dist);
      writeFileSync(join(dist, 'fixture.js'), 'export {};\n');
      const fixturePackageJson = join(fixture, 'package.json');
      writeFileSync(
        fixturePackageJson,
        `${JSON.stringify({
          ...packageJson,
          devDependencies: {
            ...packageJson.devDependencies,
            'fixture-package': specifier,
          },
        })}\n`,
      );

      const result = runPackGate(dist, fixturePackageJson);
      const output = processOutput(result);
      expect(result.exitCode, `${specifier}: ${output}`).toBe(1);
      expect(output).toContain(`devDependencies.fixture-package=${specifier}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test('build inlines Contracts rather than publishing bare Contracts imports', () => {
  const dist = mkdtempSync(join(tmpdir(), 'forgeax-cli-contracts-dist-'));
  try {
    const build = Bun.spawnSync({
      cmd: ['bun', 'build.mjs'],
      cwd: ROOT,
      env: { ...process.env, FORGEAX_DIST_DIR: dist },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(build.exitCode, processOutput(build)).toBe(0);
    expect(JSON.parse(readFileSync(join(dist, 'build-inputs.json'), 'utf8'))).toEqual({
      '@forgeax/types': '0.1.1',
      '@forgeax/agent-runtime': '0.1.1',
    });
    expect(emittedJavaScript(dist).length).toBeGreaterThan(0);

    const gate = runPackGate(dist);
    const gateOutput = processOutput(gate);
    expect(gate.exitCode, gateOutput).toBe(0);
    expect(gateOutput).toContain('CONTRACT_IMPORTS: (none)');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('npm dry-run tarball includes the Contracts build provenance file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-cli-npm-pack-'));
  try {
    const build = Bun.spawnSync({
      cmd: ['bun', 'run', 'build'],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(build.exitCode, processOutput(build)).toBe(0);

    const packed = Bun.spawnSync({
      cmd: ['npm', 'pack', '--dry-run', '--json'],
      cwd: ROOT,
      env: { ...process.env, npm_config_cache: join(fixture, 'npm-cache') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(packed.exitCode, processOutput(packed)).toBe(0);
    const fileList = JSON.parse(Buffer.from(packed.stdout).toString())[0].files.map(
      (file: { path: string }) => file.path,
    );
    expect(fileList).toContain('dist/build-inputs.json');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
