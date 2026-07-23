/**
 * `forgeax update` — self-update the globally installed `@forgeax/cli` from npm.
 *
 * Flow: detect install kind → query registry for `@tag` → compare → optionally
 * `npm install -g @forgeax/cli@<tag>` against the public registry (mirrors ignored).
 *
 * Development / monorepo checkouts and project-local installs are refused with a
 * clear manual hint (do not rewrite the running tree via -g).
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { FORGEAX_CORE_VERSION } from '../version';

export const PACKAGE_NAME = '@forgeax/cli';
export const REGISTRY = 'https://registry.npmjs.org/';

export type InstallKind = 'npm-global' | 'npm-local' | 'development' | 'unknown';

export interface UpdateArgs {
  check: boolean;
  /** npm dist-tag (default `latest`). */
  tag: string;
  help: boolean;
}

export interface UpdateIo {
  write(line: string): void;
  writeErr(line: string): void;
  /** Run `npm …`; return stdout (trimmed) or throw. */
  npm(args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null };
  /** Running entry script path (usually `process.argv[1]`). */
  entryPath: string | undefined;
  currentVersion: string;
}

const UPDATE_HELP = `forgeax update — update the globally installed @forgeax/cli

usage:
  forgeax update              install @forgeax/cli@latest from npm
  forgeax update --check      report whether an update is available (no install)
  forgeax update --tag <tag>  use a dist-tag other than latest (e.g. next)

flags:
  --check        query only; do not install
  --tag <tag>    npm dist-tag (default: latest)
  -h, --help     this help
`;

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const out: UpdateArgs = { check: false, tag: 'latest', help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--check') out.check = true;
    else if (t === '--tag') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--tag requires a dist-tag name (e.g. latest)');
      out.tag = v;
    } else if (t === '-h' || t === '--help') out.help = true;
    else throw new Error(`Unknown update arg: ${t}`);
  }
  return out;
}

/** Compare simple `x.y.z` / `x.y.z-prerelease` versions. Returns <0 if a<b, 0 if equal, >0 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // No prerelease > prerelease (1.0.0 > 1.0.0-beta).
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string } {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return { nums: [0, 0, 0], pre: String(v) };
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? '',
  };
}

/**
 * Classify how this process was launched.
 * - `npm-global`: under `npm root -g` / global prefix `node_modules/@forgeax/cli`
 * - `npm-local`: package present as a project dependency
 * - `development`: monorepo / source checkout (`packages/cli/...` without published layout)
 */
export function detectInstallKind(entryPath: string | undefined, npmGlobalRoot: string | null): InstallKind {
  if (!entryPath) return 'unknown';
  let resolved = entryPath;
  try {
    resolved = realpathSync(entryPath);
  } catch {
    // keep as-is
  }
  const norm = resolved.split(/[/\\]/).join('/');

  const inPkgLayout = /(?:^|\/)node_modules\/@forgeax\/cli(?:\/|$)/.test(norm);
  if (inPkgLayout) {
    if (npmGlobalRoot) {
      const g = npmGlobalRoot.split(/[/\\]/).join('/');
      if (norm === g || norm.startsWith(g.endsWith('/') ? g : `${g}/`)) return 'npm-global';
    }
    // Common global layouts when `npm root -g` failed / differs (nvm, fnm, prefix).
    if (/\/lib\/node_modules\/@forgeax\/cli(?:\/|$)/.test(norm)) return 'npm-global';
    return 'npm-local';
  }

  // Source / worktree: packages/cli/src|dist|… without published node_modules layout.
  if (/\/packages\/cli\/(?:src|dist|test)\//.test(norm) || /\/packages\/cli\/[^/]+\.(?:ts|js|mjs)$/.test(norm)) {
    return 'development';
  }
  if (norm.includes('/packages/cli/')) return 'development';

  return 'unknown';
}

export function defaultUpdateIo(): UpdateIo {
  return {
    write: (line) => void process.stdout.write(line.endsWith('\n') ? line : `${line}\n`),
    writeErr: (line) => void process.stderr.write(line.endsWith('\n') ? line : `${line}\n`),
    npm: (args) => {
      const r = spawnSync('npm', args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: process.env,
      });
      return {
        ok: r.status === 0,
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || '').trim(),
        status: r.status,
      };
    },
    entryPath: process.argv[1],
    currentVersion: FORGEAX_CORE_VERSION,
  };
}

function npmGlobalRoot(io: UpdateIo): string | null {
  const r = io.npm(['root', '-g']);
  if (!r.ok || !r.stdout) return null;
  return r.stdout.split(/\r?\n/)[0]?.trim() || null;
}

export function fetchLatestVersion(io: UpdateIo, tag: string): string {
  const r = io.npm(['view', `${PACKAGE_NAME}@${tag}`, 'version', '--registry', REGISTRY]);
  if (!r.ok || !r.stdout) {
    const detail = r.stderr || r.stdout || `exit ${r.status}`;
    throw new Error(`Failed to query ${PACKAGE_NAME}@${tag} from ${REGISTRY}: ${detail}`);
  }
  // `npm view` can print a JSON array when multiple versions match a range; for a
  // dist-tag it should be a single line. Take the last non-empty token.
  const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).at(-1) ?? '';
  const cleaned = line.replace(/^"+|"+$/g, '');
  if (!/^\d+\.\d+\.\d+/.test(cleaned)) {
    throw new Error(`Unexpected version from npm view: ${JSON.stringify(r.stdout)}`);
  }
  return cleaned;
}

function installGlobal(io: UpdateIo, tag: string): { ok: boolean; detail: string } {
  const r = io.npm(['install', '-g', `${PACKAGE_NAME}@${tag}`, '--registry', REGISTRY]);
  if (r.ok) return { ok: true, detail: r.stdout || 'ok' };
  const detail = r.stderr || r.stdout || `exit ${r.status}`;
  return { ok: false, detail };
}

function isPermissionError(detail: string): boolean {
  return /EACCES|EPERM|permission denied|without .*sudo|operate as a process with elevated/i.test(detail);
}

/**
 * Run `forgeax update`. Returns a process exit code.
 */
export async function runUpdate(argv: string[], io: UpdateIo = defaultUpdateIo()): Promise<number> {
  let args: UpdateArgs;
  try {
    args = parseUpdateArgs(argv);
  } catch (e) {
    io.writeErr(`[forgeax] ${e instanceof Error ? e.message : String(e)}`);
    io.writeErr(UPDATE_HELP);
    return 1;
  }
  if (args.help) {
    io.write(UPDATE_HELP);
    return 0;
  }

  const globalRoot = npmGlobalRoot(io);
  const kind = detectInstallKind(io.entryPath, globalRoot);
  const current = io.currentVersion;

  io.write(`Current version: ${current}`);
  io.write(`Install kind: ${kind}`);
  io.write(`Checking ${PACKAGE_NAME}@${args.tag} on ${REGISTRY} …`);

  let latest: string;
  try {
    latest = fetchLatestVersion(io, args.tag);
  } catch (e) {
    io.writeErr(`[forgeax] ${e instanceof Error ? e.message : String(e)}`);
    io.writeErr('Check network / registry access, then retry.');
    return 1;
  }

  io.write(`Latest (${args.tag}): ${latest}`);

  if (compareSemver(current, latest) >= 0) {
    io.write(`Already up to date (${current}).`);
    return 0;
  }

  io.write(`Update available: ${current} → ${latest}`);

  if (args.check) {
    io.write(`Run \`forgeax update\` to install ${PACKAGE_NAME}@${args.tag}.`);
    return 0;
  }

  if (kind === 'development') {
    io.writeErr('[forgeax] Refusing to update a development / monorepo checkout.');
    io.writeErr(`Install or refresh the published package instead:`);
    io.writeErr(`  npm install -g ${PACKAGE_NAME}@${args.tag} --registry ${REGISTRY}`);
    return 1;
  }

  if (kind === 'npm-local') {
    io.writeErr('[forgeax] This process is a project-local dependency, not a global install.');
    io.writeErr(`Update it from the project (e.g. bump ${PACKAGE_NAME} in package.json), or install globally:`);
    io.writeErr(`  npm install -g ${PACKAGE_NAME}@${args.tag} --registry ${REGISTRY}`);
    return 1;
  }

  if (kind === 'unknown') {
    io.write('Could not confirm a global npm install; attempting global update anyway…');
  }

  io.write(`Installing ${PACKAGE_NAME}@${args.tag} …`);
  const result = installGlobal(io, args.tag);
  if (!result.ok) {
    io.writeErr(`[forgeax] Update failed: ${result.detail}`);
    if (isPermissionError(result.detail)) {
      io.writeErr('Insufficient permissions. Fix npm global prefix permissions, or re-run with an elevated account.');
      io.writeErr(`Manual: npm install -g ${PACKAGE_NAME}@${args.tag} --registry ${REGISTRY}`);
    }
    return 1;
  }

  io.write(`Successfully updated ${current} → ${latest}.`);
  io.write('Restart any running forgeax sessions to pick up the new binary.');
  return 0;
}
