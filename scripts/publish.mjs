#!/usr/bin/env node
/**
 * @forgeax/cli release helper — bump version, build, gate, optionally npm publish.
 *
 * Usage (from packages/cli):
 *   node scripts/publish.mjs                  # bump patch + publish
 *   node scripts/publish.mjs --bump minor
 *   node scripts/publish.mjs --bump major
 *   node scripts/publish.mjs --set 0.2.0       # exact version
 *   node scripts/publish.mjs --dry-run         # bump+build+gate, no publish, restore version
 *   node scripts/publish.mjs --no-publish      # bump+build+gate only (keep bumped version)
 *   node scripts/publish.mjs --yes             # skip confirm prompt
 *
 * Notes:
 *   - Always publishes to https://registry.npmjs.org/ (ignore mirror).
 *   - Run from packages/cli; needs bun + npm on PATH.
 *   - Token: set in ~/.npmrc (user-level). Do NOT npm config set inside the monorepo.
 */
import { readFileSync, writeFileSync, symlinkSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const REGISTRY = 'https://registry.npmjs.org/';
const EXPECTED_NAME = '@forgeax/cli';

function parseArgs(argv) {
  const out = {
    bump: 'patch',
    set: null,
    dryRun: false,
    noPublish: false,
    yes: false,
    skipSmoke: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bump') out.bump = argv[++i] || 'patch';
    else if (a === '--set') out.set = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-publish') out.noPublish = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--skip-smoke') out.skipSmoke = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!['patch', 'minor', 'major'].includes(out.bump) && !out.set) {
    console.error(`--bump must be patch|minor|major (got ${out.bump})`);
    process.exit(2);
  }
  return out;
}

function bumpSemver(version, kind) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(.*)?$/);
  if (!m) throw new Error(`Not a simple semver x.y.z: ${version}`);
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  const suffix = m[4] || '';
  if (suffix && kind) {
    // strip prerelease on explicit bump
  }
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/** Compare simple x.y.z; <0 if a<b, 0 if equal, >0 if a>b. */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** npm latest, or null when the package / tag is missing (first publish). */
function fetchNpmLatest() {
  try {
    return runCapture('npm', ['view', EXPECTED_NAME, 'version', '--registry', REGISTRY]) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Pick the version to publish.
 * Auto-bump bases on max(package.json, npm latest) so a prior publish that left
 * package.json behind (or a restored checkout) still advances to a free version
 * instead of colliding with an already-published patch.
 * `--set` stays exact and still errors if that version exists on npm.
 */
function resolveTargetVersion({ from, bump, set, remote }) {
  if (set) {
    return { to: set, base: from, note: null };
  }
  let base = from;
  let note = null;
  if (remote && compareSemver(remote, from) > 0) {
    base = remote;
    note = `npm latest (${remote}) is ahead of package.json (${from}); basing bump on npm.`;
  }
  return { to: bumpSemver(base, bump), base, note };
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim());
  }
  return (r.stdout || '').trim();
}

function readPkg() {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8'));
}

function writePkg(pkg) {
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function symlinkSmoke() {
  const bin = join(ROOT, 'dist/cli/main.js');
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-publish-'));
  const link = join(dir, 'forgeax');
  try {
    symlinkSync(bin, link);
    chmodSync(bin, 0o755);
    console.log('\n> symlink smoke: forgeax -v');
    const r = spawnSync(link, ['-v'], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    console.log(out || '(no output)');
    if (r.status !== 0) throw new Error(`symlink smoke exit ${r.status}`);
    if (!/forgeax/i.test(out) && !/\d+\.\d+\.\d+/.test(out)) {
      throw new Error('symlink smoke: expected version output (entry guard / symlink bug?)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function confirm(msg) {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(`${msg} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`Usage: node scripts/publish.mjs [options]

Options:
  --bump patch|minor|major   Semver bump (default: patch). Base is
                             max(package.json, npm latest) so a drifted
                             local version still advances past published.
  --set <x.y.z>              Set exact version (skips --bump; errors if taken)
  --dry-run                  Build+gate only; restore package.json version
  --no-publish               Bump+build+gate; do not npm publish
  --yes, -y                  Skip confirmation
  --skip-smoke               Skip global-bin symlink smoke test
  -h, --help                 Show help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pkg = readPkg();
  if (pkg.name !== EXPECTED_NAME) {
    throw new Error(
      `Refusing to publish: package name is "${pkg.name}", expected "${EXPECTED_NAME}". ` +
        'You may be on the wrong branch/checkout (old orchestrator?).',
    );
  }
  if (pkg.private === true) {
    throw new Error('package.json has "private": true — flip to false before release.');
  }

  const from = pkg.version;

  // Resolve target against npm *before* confirm, so a drifted package.json does not
  // propose a version that already exists and then fail after the user said yes.
  const remote = fetchNpmLatest();
  console.log(`npm latest: ${remote || '(none)'}`);

  const resolved = resolveTargetVersion({
    from,
    bump: args.bump,
    set: args.set,
    remote,
  });
  const to = resolved.to;
  if (!/^\d+\.\d+\.\d+$/.test(to)) {
    throw new Error(`Invalid target version: ${to}`);
  }
  if (resolved.note) console.log(`Note: ${resolved.note}`);

  if (remote && remote === to) {
    // Only reachable with --set (auto-bump always advances past remote).
    throw new Error(
      `${EXPECTED_NAME}@${to} already exists on npm. Pick another --set, or omit --set to auto-bump.`,
    );
  }

  console.log(`Package: ${pkg.name}`);
  console.log(`Version: ${from} → ${to}${resolved.base !== from ? ` (bumped from ${resolved.base})` : ''}`);
  console.log(`Registry: ${REGISTRY}`);
  console.log(
    `Mode: ${args.dryRun ? 'dry-run (no publish, restore version)' : args.noPublish ? 'no-publish (keep bump)' : 'publish'}`,
  );

  if (!args.yes && !args.dryRun) {
    const ok = await confirm(`Proceed with ${args.noPublish ? 'bump+build' : 'publish'} ${to}?`);
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // whoami early (non-fatal for --no-publish / dry-run)
  if (!args.dryRun && !args.noPublish) {
    try {
      const who = runCapture('npm', ['whoami', '--registry', REGISTRY]);
      console.log(`npm whoami: ${who}`);
    } catch (e) {
      throw new Error(
        `Not logged in to ${REGISTRY}.\n` +
          `  cd ~ && npm config set //registry.npmjs.org/:_authToken=npm_XXX --location=user\n` +
          `  npm whoami --registry ${REGISTRY}\n` +
          `Detail: ${e.message}`,
      );
    }
  }

  pkg.version = to;
  writePkg(pkg);
  console.log(`Wrote package.json version ${to}`);

  try {
    run('bun', ['run', 'build']);
    run('node', ['scripts/check-pack-deps.mjs']);
    if (!args.skipSmoke) symlinkSmoke();

    if (args.dryRun) {
      console.log('\nDry-run OK — restoring package.json version.');
      pkg.version = from;
      writePkg(pkg);
      console.log(`Restored version ${from}`);
      return;
    }

    if (args.noPublish) {
      console.log(`\nDone (no publish). package.json is now ${to}.`);
      console.log('When ready: npm publish --access public --registry https://registry.npmjs.org/');
      return;
    }

    // prepublishOnly also builds; still fine
    run('npm', ['publish', '--access', 'public', '--registry', REGISTRY]);
    console.log(`\nPublished ${EXPECTED_NAME}@${to}`);
    console.log(`Verify: npm view ${EXPECTED_NAME} version --registry ${REGISTRY}`);
    console.log(`Install: npm install -g ${EXPECTED_NAME}@${to}`);
  } catch (e) {
    if (args.dryRun) {
      pkg.version = from;
      writePkg(pkg);
    }
    console.error(`\nFAILED: ${e.message}`);
    if (!args.dryRun && pkg.version === to && from !== to) {
      console.error(
        `package.json left at ${to}. Fix the error, or set version back to ${from} before retrying.`,
      );
    }
    process.exit(1);
  }
}

main();
