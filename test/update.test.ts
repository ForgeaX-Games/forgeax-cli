/**
 * Unit tests for `forgeax update` (cli/update.ts).
 * Hermetic: no real npm / network — inject UpdateIo.
 */
import { describe, expect, test } from 'bun:test';
import {
  PACKAGE_NAME,
  REGISTRY,
  compareSemver,
  detectInstallKind,
  fetchLatestVersion,
  parseUpdateArgs,
  runUpdate,
  type UpdateIo,
} from '../src/cli/update';

function makeIo(partial: Partial<UpdateIo> & { npmImpl?: (args: string[]) => ReturnType<UpdateIo['npm']> }): {
  io: UpdateIo;
  out: string[];
  err: string[];
  npmCalls: string[][];
} {
  const out: string[] = [];
  const err: string[] = [];
  const npmCalls: string[][] = [];
  const io: UpdateIo = {
    write: (line) => out.push(line.replace(/\n$/, '')),
    writeErr: (line) => err.push(line.replace(/\n$/, '')),
    npm: (args) => {
      npmCalls.push(args);
      if (partial.npmImpl) return partial.npmImpl(args);
      return { ok: true, stdout: '', stderr: '', status: 0 };
    },
    entryPath: partial.entryPath ?? '/usr/local/lib/node_modules/@forgeax/cli/dist/cli/main.js',
    currentVersion: partial.currentVersion ?? '0.1.0',
  };
  return { io, out, err, npmCalls };
}

describe('parseUpdateArgs', () => {
  test('defaults', () => {
    expect(parseUpdateArgs([])).toEqual({ check: false, tag: 'latest', help: false });
  });

  test('--check and --tag', () => {
    expect(parseUpdateArgs(['--check', '--tag', 'next'])).toEqual({
      check: true,
      tag: 'next',
      help: false,
    });
  });

  test('unknown arg throws', () => {
    expect(() => parseUpdateArgs(['--force'])).toThrow(/Unknown update arg/);
  });

  test('--tag without value throws', () => {
    expect(() => parseUpdateArgs(['--tag'])).toThrow(/--tag requires/);
  });
});

describe('compareSemver', () => {
  test('orders patch/minor/major', () => {
    expect(compareSemver('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  test('release > prerelease', () => {
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0);
  });
});

describe('detectInstallKind', () => {
  test('npm-global under npm root -g', () => {
    expect(
      detectInstallKind(
        '/Users/you/.nvm/versions/node/v22.0.0/lib/node_modules/@forgeax/cli/dist/cli/main.js',
        '/Users/you/.nvm/versions/node/v22.0.0/lib/node_modules',
      ),
    ).toBe('npm-global');
  });

  test('npm-global via lib/node_modules layout without root hint', () => {
    expect(
      detectInstallKind('/usr/local/lib/node_modules/@forgeax/cli/dist/cli/main.js', null),
    ).toBe('npm-global');
  });

  test('npm-local project dependency', () => {
    expect(
      detectInstallKind(
        '/Users/you/proj/node_modules/@forgeax/cli/dist/cli/main.js',
        '/Users/you/.nvm/versions/node/v22.0.0/lib/node_modules',
      ),
    ).toBe('npm-local');
  });

  test('development monorepo checkout', () => {
    expect(
      detectInstallKind(
        '/Users/you/forgeax-os/packages/cli/src/cli/main.ts',
        '/Users/you/.nvm/versions/node/v22.0.0/lib/node_modules',
      ),
    ).toBe('development');
  });
});

describe('fetchLatestVersion', () => {
  test('parses npm view stdout', () => {
    const { io } = makeIo({
      npmImpl: (args) => {
        expect(args).toEqual(['view', `${PACKAGE_NAME}@latest`, 'version', '--registry', REGISTRY]);
        return { ok: true, stdout: '0.1.6\n', stderr: '', status: 0 };
      },
    });
    expect(fetchLatestVersion(io, 'latest')).toBe('0.1.6');
  });

  test('throws on npm failure', () => {
    const { io } = makeIo({
      npmImpl: () => ({ ok: false, stdout: '', stderr: 'network error', status: 1 }),
    });
    expect(() => fetchLatestVersion(io, 'latest')).toThrow(/Failed to query/);
  });
});

describe('runUpdate', () => {
  test('--help prints usage', async () => {
    const { io, out } = makeIo({});
    expect(await runUpdate(['--help'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/forgeax update/);
  });

  test('already up to date', async () => {
    const { io, out, npmCalls } = makeIo({
      currentVersion: '0.1.6',
      npmImpl: (args) => {
        if (args[0] === 'root') return { ok: true, stdout: '/usr/local/lib/node_modules', stderr: '', status: 0 };
        if (args[0] === 'view') return { ok: true, stdout: '0.1.6', stderr: '', status: 0 };
        return { ok: false, stdout: '', stderr: 'unexpected', status: 1 };
      },
    });
    expect(await runUpdate([], io)).toBe(0);
    expect(out.some((l) => /Already up to date/.test(l))).toBe(true);
    expect(npmCalls.some((a) => a[0] === 'install')).toBe(false);
  });

  test('--check reports available update without installing', async () => {
    const { io, out, npmCalls } = makeIo({
      currentVersion: '0.1.0',
      npmImpl: (args) => {
        if (args[0] === 'root') return { ok: true, stdout: '/usr/local/lib/node_modules', stderr: '', status: 0 };
        if (args[0] === 'view') return { ok: true, stdout: '0.1.6', stderr: '', status: 0 };
        return { ok: false, stdout: '', stderr: 'unexpected', status: 1 };
      },
    });
    expect(await runUpdate(['--check'], io)).toBe(0);
    expect(out.some((l) => /0\.1\.0 → 0\.1\.6/.test(l))).toBe(true);
    expect(npmCalls.some((a) => a[0] === 'install')).toBe(false);
  });

  test('global install runs npm install -g', async () => {
    const { io, out, npmCalls } = makeIo({
      currentVersion: '0.1.0',
      entryPath: '/usr/local/lib/node_modules/@forgeax/cli/dist/cli/main.js',
      npmImpl: (args) => {
        if (args[0] === 'root') return { ok: true, stdout: '/usr/local/lib/node_modules', stderr: '', status: 0 };
        if (args[0] === 'view') return { ok: true, stdout: '0.1.6', stderr: '', status: 0 };
        if (args[0] === 'install') return { ok: true, stdout: 'added 1 package', stderr: '', status: 0 };
        return { ok: false, stdout: '', stderr: 'unexpected', status: 1 };
      },
    });
    expect(await runUpdate([], io)).toBe(0);
    expect(npmCalls).toContainEqual([
      'install',
      '-g',
      `${PACKAGE_NAME}@latest`,
      '--registry',
      REGISTRY,
    ]);
    expect(out.some((l) => /Successfully updated 0\.1\.0 → 0\.1\.6/.test(l))).toBe(true);
  });

  test('development checkout is refused', async () => {
    const { io, err, npmCalls } = makeIo({
      currentVersion: '0.1.0',
      entryPath: '/Users/you/forgeax-os/packages/cli/src/cli/main.ts',
      npmImpl: (args) => {
        if (args[0] === 'root') return { ok: true, stdout: '/usr/local/lib/node_modules', stderr: '', status: 0 };
        if (args[0] === 'view') return { ok: true, stdout: '0.1.6', stderr: '', status: 0 };
        return { ok: false, stdout: '', stderr: 'unexpected', status: 1 };
      },
    });
    expect(await runUpdate([], io)).toBe(1);
    expect(err.some((l) => /development|monorepo/i.test(l))).toBe(true);
    expect(npmCalls.some((a) => a[0] === 'install')).toBe(false);
  });

  test('permission failure prints manual hint', async () => {
    const { io, err } = makeIo({
      currentVersion: '0.1.0',
      entryPath: '/usr/local/lib/node_modules/@forgeax/cli/dist/cli/main.js',
      npmImpl: (args) => {
        if (args[0] === 'root') return { ok: true, stdout: '/usr/local/lib/node_modules', stderr: '', status: 0 };
        if (args[0] === 'view') return { ok: true, stdout: '0.1.6', stderr: '', status: 0 };
        if (args[0] === 'install') {
          return { ok: false, stdout: '', stderr: 'Error: EACCES: permission denied', status: 1 };
        }
        return { ok: false, stdout: '', stderr: 'unexpected', status: 1 };
      },
    });
    expect(await runUpdate([], io)).toBe(1);
    expect(err.some((l) => /Insufficient permissions/.test(l))).toBe(true);
    expect(err.some((l) => /npm install -g/.test(l))).toBe(true);
  });
});
