/**
 * Phase D7 — `.fxpack` exporter / importer round-trip + lint contract.
 *
 * Each test builds a mini "plugin dir" under /tmp, exports it to a .fxpack,
 * inspects, and (where relevant) installs to a fresh /tmp dest root. We
 * keep the snapshot empty in most tests via _resetSnapshotForTests so
 * conflict detection is deterministic; the conflict-detection test seeds a
 * snapshot via `_setSnapshotForTests` to assert against.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportPack, closureFrom } from '../src/packs/exporter';
import { inspectPack, installPack } from '../src/packs/importer';
import { _setSnapshotForTests, _resetSnapshotForTests, type PluginSnapshot } from '../src/plugins/registry';

const TMP = `/tmp/forgeax-packs-${process.pid}`;

function emptySnapshot(): PluginSnapshot {
  return {
    generation: 0,
    loadedAt: 0,
    manifests: [],
    kinds: { workbench: [], agents: [], skills: [], cliProviders: [], modelBindings: [], tools: [], issues: [] },
    scanErrors: [],
    mergeIssues: [],
  };
}

function writeMinimalPlugin(srcDir: string, id: string, version = '0.1.0'): void {
  mkdirSync(srcDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    kind: 'tool',
    displayName: { en: id },
    author: { name: 'tester' },
    permissions: [`fs:read:.forgeax/plugins/${id}/**`],
    provides: { tools: [{ id: `${id}:hello` }] },
    entry: { backend: './handlers.ts' },
    compatibleWith: { 'forgeax-bus': '^1.0.0' },
  };
  writeFileSync(join(srcDir, 'forgeax-plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(
    join(srcDir, 'handlers.ts'),
    'export const tools = { "${id}:hello": () => ({ greeting: "hi" }) };\n'.replace('${id}', id),
    'utf-8',
  );
  writeFileSync(join(srcDir, 'README.md'), `# ${id}\n\nminimal demo plugin\n`, 'utf-8');
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  _setSnapshotForTests(emptySnapshot());
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
});

describe('packs exporter', () => {
  it('produces a .fxpack containing manifest.fxpack.json + plugin tree', async () => {
    const src = join(TMP, 'src', 'hello');
    writeMinimalPlugin(src, '@me/hello');
    const out = join(TMP, 'out', 'hello.fxpack');

    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/hello', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/hello', version: '0.1.0', title: { en: 'Hello' } },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(out)).toBe(true);
    expect(r.manifest.contains).toEqual([
      { id: '@me/hello', kind: 'tool', version: '0.1.0' },
    ]);
    expect(r.manifest.primary).toBe('@me/hello');
  });

  it('rejects export when plugin contains a native binary (.so)', async () => {
    const src = join(TMP, 'native', 'p');
    writeMinimalPlugin(src, '@me/native');
    writeFileSync(join(src, 'native.so'), 'fake', 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/native', srcDir: src }],
      outPath: join(TMP, 'out.fxpack'),
      bundleMeta: { id: '@me/native', version: '0.1.0', title: { en: 'N' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('native_binary');
  });

  it('rejects export when a text file leaks an OPENAI sk- secret', async () => {
    const src = join(TMP, 'leak', 'p');
    writeMinimalPlugin(src, '@me/leaks');
    writeFileSync(join(src, 'config.json'), `{ "key": "sk-${'A'.repeat(40)}" }\n`, 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/leaks', srcDir: src }],
      outPath: join(TMP, 'leak.fxpack'),
      bundleMeta: { id: '@me/leaks', version: '0.1.0', title: { en: 'L' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('secret');
  });

  it('rejects export when a text file embeds /Users absolute path', async () => {
    const src = join(TMP, 'abs', 'p');
    writeMinimalPlugin(src, '@me/abs');
    writeFileSync(join(src, 'paths.json'), `{ "x": "/Users/you/docs/file.md" }\n`, 'utf-8');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/abs', srcDir: src }],
      outPath: join(TMP, 'abs.fxpack'),
      bundleMeta: { id: '@me/abs', version: '0.1.0', title: { en: 'A' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('lint_error');
    expect(JSON.stringify(r.details)).toContain('absolute_path');
  });

  it('rejects bad input when type=single but multiple plugins given', async () => {
    const r = await exportPack({
      type: 'single',
      plugins: [
        { id: '@me/a', srcDir: join(TMP, 'a') },
        { id: '@me/b', srcDir: join(TMP, 'b') },
      ],
      outPath: join(TMP, 'x.fxpack'),
      bundleMeta: { id: 'b', version: '0.1.0', title: { en: 'B' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });
});

describe('packs importer', () => {
  it('inspectPack returns manifest + permissions + unsigned warning', async () => {
    const src = join(TMP, 'src', 'p');
    writeMinimalPlugin(src, '@me/inspectable');
    const out = join(TMP, 'p.fxpack');
    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/inspectable', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/inspectable', version: '0.1.0', title: { en: 'I' } },
    });
    expect(exp.ok).toBe(true);

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.manifest.contains).toHaveLength(1);
    expect(insp.trust.permissions['@me/inspectable']).toEqual([
      'fs:read:.forgeax/plugins/@me/inspectable/**',
    ]);
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.warnings.some((w) => w.includes('未签名'))).toBe(true);
    expect(insp.trust.conflicts).toEqual([]);
  });

  it('inspectPack flags a conflict when an id is already in the snapshot', async () => {
    const src = join(TMP, 'src', 'c');
    writeMinimalPlugin(src, '@me/conflicty', '0.2.0');
    const out = join(TMP, 'c.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/conflicty', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/conflicty', version: '0.2.0', title: { en: 'C' } },
    });

    // Seed the snapshot with an older copy of the same id at L1.
    const seeded: PluginSnapshot = {
      ...emptySnapshot(),
      manifests: [
        {
          manifest: {
            schemaVersion: 1,
            id: '@me/conflicty',
            version: '0.1.0',
            kind: 'tool',
            displayName: { en: 'C' },
            author: { name: 'old' },
            provides: { tools: [{ id: '@me/conflicty:t' }] },
            entry: { backend: './h.ts' },
            compatibleWith: { 'forgeax-bus': '^1.0.0' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          layer: 'L1',
          originPath: '/tmp/seed',
          shadowedBy: [],
        },
      ],
    };
    _setSnapshotForTests(seeded);

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.conflicts).toEqual([
      { id: '@me/conflicty', existingLayer: 'L1', existingVersion: '0.1.0', newVersion: '0.2.0' },
    ]);
  });

  it('inspectPack returns manifest_missing when the zip lacks manifest.fxpack.json', async () => {
    // Build a "fake" pack by zipping a dir that only has a junk file.
    const stage = join(TMP, 'badstage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'unrelated.txt'), 'hi', 'utf-8');
    const out = join(TMP, 'bad.fxpack');
    const proc = Bun.spawn(['zip', '-r', '-q', out, '.'], { cwd: stage });
    await proc.exited;

    const r = await inspectPack(out);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('manifest_missing');
  });

  it('installPack writes plugin tree under <destRoot>/.forgeax/plugins/<id>/', async () => {
    const src = join(TMP, 'src', 'i');
    writeMinimalPlugin(src, '@me/installable');
    const out = join(TMP, 'i.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/installable', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/installable', version: '0.1.0', title: { en: 'I' } },
    });

    const destRoot = join(TMP, 'dest');
    mkdirSync(destRoot, { recursive: true });
    const r = await installPack({
      zipPath: out,
      destRoot,
      destLayer: 'L2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installed).toEqual(['@me/installable']);
    expect(r.skipped).toEqual([]);

    const installedManifest = readFileSync(
      join(destRoot, '.forgeax', 'plugins', 'installable', 'forgeax-plugin.json'),
      'utf-8',
    );
    expect(JSON.parse(installedManifest).id).toBe('@me/installable');
  });

  it('installPack with conflictPolicy=skip leaves existing copy alone', async () => {
    const src = join(TMP, 'src', 'i');
    writeMinimalPlugin(src, '@me/skippable');
    const out = join(TMP, 'i.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/skippable', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/skippable', version: '0.1.0', title: { en: 'S' } },
    });

    const destRoot = join(TMP, 'dest');
    mkdirSync(join(destRoot, '.forgeax/plugins/skippable'), { recursive: true });
    writeFileSync(
      join(destRoot, '.forgeax/plugins/skippable/MARKER'),
      'pre-existing',
      'utf-8',
    );

    const r = await installPack({
      zipPath: out,
      destRoot,
      destLayer: 'L2',
      conflictPolicy: 'skip',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toEqual(['@me/skippable']);
    expect(r.installed).toEqual([]);
    // The marker survived → existing tree was untouched.
    expect(
      readFileSync(join(destRoot, '.forgeax/plugins/skippable/MARKER'), 'utf-8'),
    ).toBe('pre-existing');
  });

  it('installPack with conflictPolicy=overwrite replaces existing copy', async () => {
    const src = join(TMP, 'src', 'o');
    writeMinimalPlugin(src, '@me/overwriteable');
    const out = join(TMP, 'o.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/overwriteable', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/overwriteable', version: '0.1.0', title: { en: 'O' } },
    });

    const destRoot = join(TMP, 'dest');
    mkdirSync(join(destRoot, '.forgeax/plugins/overwriteable'), { recursive: true });
    writeFileSync(join(destRoot, '.forgeax/plugins/overwriteable/STALE'), 'old', 'utf-8');

    const r = await installPack({
      zipPath: out,
      destRoot,
      destLayer: 'L2',
      conflictPolicy: 'overwrite',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installed).toEqual(['@me/overwriteable']);
    // STALE marker is gone, manifest is now present.
    expect(existsSync(join(destRoot, '.forgeax/plugins/overwriteable/STALE'))).toBe(false);
    expect(existsSync(join(destRoot, '.forgeax/plugins/overwriteable/forgeax-plugin.json'))).toBe(true);
  });

  it('installPack returns bad_input when zip path missing', async () => {
    const r = await installPack({
      zipPath: join(TMP, 'does-not-exist.fxpack'),
      destRoot: TMP,
      destLayer: 'L1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });
});

describe('packs ledger', () => {
  it('installPack appends to <destRoot>/.forgeax/installed.yaml', async () => {
    const { recordTrust, readInstalled, readTrust, latestTrustFor } = await import(
      '../src/packs/ledger'
    );
    const src = join(TMP, 'src', 'led');
    writeMinimalPlugin(src, '@me/ledgerable');
    const out = join(TMP, 'led.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/ledgerable', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/ledgerable', version: '0.1.0', title: { en: 'L' } },
    });

    const destRoot = join(TMP, 'led-dest');
    mkdirSync(destRoot, { recursive: true });
    const r = await installPack({ zipPath: out, destRoot, destLayer: 'L2' });
    expect(r.ok).toBe(true);

    const led = readInstalled(destRoot);
    expect(led).toHaveLength(1);
    expect(led[0].id).toBe('@me/ledgerable');
    expect(led[0].slug).toBe('ledgerable');
    expect(led[0].layer).toBe('L2');
    expect(led[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(led[0].ts).toMatch(/T/);

    // re-install (overwrite) appends a 2nd entry — append-only invariant.
    const r2 = await installPack({ zipPath: out, destRoot, destLayer: 'L2', conflictPolicy: 'overwrite' });
    expect(r2.ok).toBe(true);
    expect(readInstalled(destRoot)).toHaveLength(2);

    // trust ack → append + supersedes
    recordTrust(destRoot, { id: '@me/ledgerable', decision: 'allow', signed: false, ts: '2026-05-23T00:00:00Z' });
    recordTrust(destRoot, { id: '@me/ledgerable', decision: 'deny', signed: false, ts: '2026-05-23T00:01:00Z', supersedes: '2026-05-23T00:00:00Z', reason: 'changed mind' });
    expect(readTrust(destRoot)).toHaveLength(2);
    const latest = latestTrustFor(destRoot, '@me/ledgerable');
    expect(latest?.decision).toBe('deny');
    expect(latest?.supersedes).toBe('2026-05-23T00:00:00Z');
  });
});

describe('packs bundle closure', () => {
  it('auto-includes a dependency plugin from the snapshot when bundling', async () => {
    // Lay down two plugin dirs on disk: a "host" workbench that depends on
    // a "dep" tool. Seed the snapshot with the dep so the closure walker
    // can resolve it (`originPath` → `dirname` → srcDir).
    const hostDir = join(TMP, 'src', 'host');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, 'forgeax-plugin.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: '@me/host',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { en: 'Host' },
          author: { name: 't' },
          dependencies: [{ id: '@me/dep' }],
          provides: { workbench: { id: 'host:wb' } },
          entry: { backend: './h.ts' },
          compatibleWith: { 'forgeax-bus': '^1.0.0' },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(hostDir, 'h.ts'), 'export const ok = true;\n', 'utf-8');

    const depDir = join(TMP, 'src', 'dep');
    writeMinimalPlugin(depDir, '@me/dep');

    // Seed snapshot so closure walker can find the dep at originPath/...
    const seeded: PluginSnapshot = {
      ...emptySnapshot(),
      manifests: [
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          manifest: JSON.parse(readFileSync(join(depDir, 'forgeax-plugin.json'), 'utf-8')) as any,
          layer: 'L2',
          originPath: join(depDir, 'forgeax-plugin.json'),
          shadowedBy: [],
        },
      ],
    };
    _setSnapshotForTests(seeded);

    const out = join(TMP, 'bundle.fxpack');
    const r = await exportPack({
      type: 'bundle',
      plugins: [{ id: '@me/host', srcDir: hostDir }],
      outPath: out,
      bundleMeta: { id: '@me/host-bundle', version: '0.1.0', title: { en: 'B' } },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contains.map((c) => c.id).sort()).toEqual(['@me/dep', '@me/host']);
    expect(r.warnings.some((w) => w.includes('@me/dep'))).toBe(true);
  });

  it('returns bad_input when a non-optional dependency is missing from the snapshot', async () => {
    const hostDir = join(TMP, 'src', 'host');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@me/host',
        version: '0.1.0',
        kind: 'workbench',
        displayName: { en: 'Host' },
        author: { name: 't' },
        dependencies: [{ id: '@me/missing' }],
        provides: { workbench: { id: 'host:wb' } },
        entry: { backend: './h.ts' },
        compatibleWith: { 'forgeax-bus': '^1.0.0' },
      }),
      'utf-8',
    );
    writeFileSync(join(hostDir, 'h.ts'), 'export const ok = true;\n', 'utf-8');

    const r = await exportPack({
      type: 'bundle',
      plugins: [{ id: '@me/host', srcDir: hostDir }],
      outPath: join(TMP, 'bad.fxpack'),
      bundleMeta: { id: '@me/host', version: '0.1.0', title: { en: 'B' } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
    expect(r.error).toContain('@me/missing');
  });

  it('skips optional dependencies in the closure walk', async () => {
    const hostDir = join(TMP, 'src', 'host');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@me/host',
        version: '0.1.0',
        kind: 'workbench',
        displayName: { en: 'Host' },
        author: { name: 't' },
        dependencies: [{ id: '@me/missing', optional: true }],
        provides: { workbench: { id: 'host:wb' } },
        entry: { backend: './h.ts' },
        compatibleWith: { 'forgeax-bus': '^1.0.0' },
      }),
      'utf-8',
    );
    writeFileSync(join(hostDir, 'h.ts'), 'export const ok = true;\n', 'utf-8');

    const r = await exportPack({
      type: 'bundle',
      plugins: [{ id: '@me/host', srcDir: hostDir }],
      outPath: join(TMP, 'opt.fxpack'),
      bundleMeta: { id: '@me/host', version: '0.1.0', title: { en: 'B' } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contains.map((c) => c.id)).toEqual(['@me/host']);
  });
});

describe('packs signing', () => {
  it('signs a pack on export and verifies on inspect', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'sig');
    writeMinimalPlugin(src, '@me/signed');
    const out = join(TMP, 'sig.fxpack');
    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/signed', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/signed', version: '0.1.0', title: { en: 'S' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });
    expect(exp.ok).toBe(true);

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(true);
    expect(insp.trust.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(insp.trust.warnings.some((w) => w.startsWith('已签名'))).toBe(true);
    expect(insp.trust.warnings.some((w) => w.includes('未签名'))).toBe(false);
  });

  it('flags signature failure when a signed pack is tampered with', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'tamper');
    writeMinimalPlugin(src, '@me/tampered');
    const out = join(TMP, 'tamper.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/tampered', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/tampered', version: '0.1.0', title: { en: 'T' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    // Surgically corrupt one file inside the pack.
    const hack = join(TMP, 'hack');
    mkdirSync(hack, { recursive: true });
    const unzip = Bun.spawn(['unzip', '-q', out, '-d', hack]);
    await unzip.exited;
    writeFileSync(join(hack, 'plugins/@me/tampered/handlers.ts'), 'export const tools = {};\n', 'utf-8');
    rmSync(out, { force: true });
    const rezip = Bun.spawn(['zip', '-r', '-q', out, '.'], { cwd: hack });
    await rezip.exited;

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.warnings.some((w) => w.includes('签名校验失败'))).toBe(true);
  });

  it('an unsigned pack still inspects but warns 未签名', async () => {
    const src = join(TMP, 'src', 'plain');
    writeMinimalPlugin(src, '@me/plain');
    const out = join(TMP, 'plain.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/plain', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/plain', version: '0.1.0', title: { en: 'P' } },
    });
    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.warnings.some((w) => w.includes('未签名'))).toBe(true);
  });
});

describe('packs ed25519 verification on import', () => {
  it('rejects a pack whose signature was forged with a different key pair', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    // Two independent key pairs: realPair signs the staging files, but we
    // overwrite signature.json's publicKey with attackerPair's pub so the
    // ed25519 verify call must fail (key mismatches the bytes that produced
    // the signature).
    const realPair = generateKeyPairSync('ed25519');
    const attackerPair = generateKeyPairSync('ed25519');
    const realPriv = realPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const realPub = realPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const attackerPub = attackerPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'forge');
    writeMinimalPlugin(src, '@me/forged');
    const out = join(TMP, 'forged.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/forged', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/forged', version: '0.1.0', title: { en: 'F' } },
      signWith: { privateKey: realPriv, publicKey: realPub },
    });

    // Unzip, swap publicKey to the attacker's, re-zip. The signature itself
    // is unchanged — verification must still fail because the signature does
    // not match a payload signed by attackerPub.
    const hack = join(TMP, 'forge-hack');
    mkdirSync(hack, { recursive: true });
    const unzip = Bun.spawn(['unzip', '-q', out, '-d', hack]);
    await unzip.exited;
    const sigPath = join(hack, 'signature.json');
    const sig = JSON.parse(readFileSync(sigPath, 'utf-8'));
    sig.publicKey = attackerPub;
    writeFileSync(sigPath, JSON.stringify(sig, null, 2), 'utf-8');
    rmSync(out, { force: true });
    const rezip = Bun.spawn(['zip', '-r', '-q', out, '.'], { cwd: hack });
    await rezip.exited;

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(false);
    expect(insp.trust.warnings.some((w) => w.includes('签名校验失败'))).toBe(true);
  });

  it('sets signed=true only when crypto.verify confirms the signature', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'verify');
    writeMinimalPlugin(src, '@me/verify');
    const out = join(TMP, 'verify.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/verify', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/verify', version: '0.1.0', title: { en: 'V' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(true);
    expect(insp.trust.publicKey).toBe(pubPem.trim() + '\n' === pubPem ? pubPem : insp.trust.publicKey);
    // Sanity: the verified pubkey is the same one the export embedded.
    expect(insp.trust.publicKey?.replace(/\s+/g, '')).toBe(pubPem.replace(/\s+/g, ''));
  });
});

describe('packs trusted-keys', () => {
  it('marks signerTrust=trusted when key is in the project trusted-keys.yaml', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'tk-trusted');
    writeMinimalPlugin(src, '@me/tk-trusted');
    const out = join(TMP, 'tk-trusted.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/tk-trusted', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/tk-trusted', version: '0.1.0', title: { en: 'T' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    // Seed a project trusted-keys.yaml with the publisher allowlisted.
    const projectRoot = join(TMP, 'tk-project');
    mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
    const { recordTrustedKey } = await import('../src/packs/trusted-keys');
    recordTrustedKey({
      publicKey: pubPem,
      label: 'Lock @ forgeax',
      trust: 'trusted',
      projectRoot,
      homeDir: join(TMP, 'tk-empty-home'),
    });

    const insp = await inspectPack(out, { trustLookup: { projectRoot, homeDir: join(TMP, 'tk-empty-home') } });
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(true);
    expect(insp.trust.signerTrust).toBe('trusted');
    expect(insp.trust.signerLabel).toBe('Lock @ forgeax');
    expect(insp.trust.signerTrustSource).toBe('project');
    expect(insp.trust.warnings.some((w) => w.includes('信任发布者'))).toBe(true);
  });

  it('marks signerTrust=unknown when signed but key is not on file', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'tk-unknown');
    writeMinimalPlugin(src, '@me/tk-unknown');
    const out = join(TMP, 'tk-unknown.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/tk-unknown', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/tk-unknown', version: '0.1.0', title: { en: 'U' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    const insp = await inspectPack(out, {
      trustLookup: { homeDir: join(TMP, 'tk-empty-home') },
    });
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signed).toBe(true);
    expect(insp.trust.signerTrust).toBe('unknown');
    expect(insp.trust.warnings.some((w) => w.includes('未知发布者'))).toBe(true);
  });

  it('hard-blocks installPack when signing key is revoked', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'tk-revoked');
    writeMinimalPlugin(src, '@me/tk-revoked');
    const out = join(TMP, 'tk-revoked.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/tk-revoked', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/tk-revoked', version: '0.1.0', title: { en: 'R' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    const projectRoot = join(TMP, 'tk-revoked-project');
    mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
    const { recordTrustedKey } = await import('../src/packs/trusted-keys');
    recordTrustedKey({
      publicKey: pubPem,
      label: 'compromised key',
      trust: 'revoked',
      projectRoot,
      homeDir: join(TMP, 'tk-empty-home'),
    });

    const dest = join(TMP, 'tk-revoked-dest');
    mkdirSync(dest, { recursive: true });
    const r = await installPack({
      zipPath: out,
      destRoot: dest,
      destLayer: 'L1',
      trustLookup: { projectRoot, homeDir: join(TMP, 'tk-empty-home') },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('inspect_failed');
    expect(r.error).toContain('revoked');
  });

  it('latest revoked entry supersedes earlier trusted entry', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const src = join(TMP, 'src', 'tk-supersede');
    writeMinimalPlugin(src, '@me/tk-supersede');
    const out = join(TMP, 'tk-super.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/tk-supersede', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/tk-supersede', version: '0.1.0', title: { en: 'S' } },
      signWith: { privateKey: privPem, publicKey: pubPem },
    });

    const projectRoot = join(TMP, 'tk-super-project');
    mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
    const { recordTrustedKey } = await import('../src/packs/trusted-keys');
    recordTrustedKey({
      publicKey: pubPem,
      label: 'Lock',
      trust: 'trusted',
      projectRoot,
      homeDir: join(TMP, 'tk-empty-home'),
    });
    recordTrustedKey({
      publicKey: pubPem,
      label: 'Lock (revoked)',
      trust: 'revoked',
      supersedes: 'first-entry-ts',
      projectRoot,
      homeDir: join(TMP, 'tk-empty-home'),
    });

    const insp = await inspectPack(out, { trustLookup: { projectRoot, homeDir: join(TMP, 'tk-empty-home') } });
    expect(insp.ok).toBe(true);
    if (!insp.ok) return;
    expect(insp.trust.signerTrust).toBe('revoked');
    expect(insp.trust.signerLabel).toBe('Lock (revoked)');
  });
});

describe('packs closure helper', () => {
  it('closureFrom walks transitive non-optional dependencies BFS', async () => {
    // Build A -> B -> C and A -> (D optional). Closure from A must yield
    // [A, B, C] in BFS order; D is skipped because it is optional.
    const dirs: Record<string, string> = {};
    const seedManifest = (id: string, deps: Array<{ id: string; optional?: boolean }> = []): void => {
      const dir = join(TMP, 'closure-src', id.replace(/\//g, '_'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'forgeax-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: '0.1.0',
          kind: 'tool',
          displayName: { en: id },
          author: { name: 't' },
          dependencies: deps,
          provides: { tools: [{ id: `${id}:t` }] },
          entry: { backend: './h.ts' },
          compatibleWith: { 'forgeax-bus': '^1.0.0' },
        }),
        'utf-8',
      );
      dirs[id] = dir;
    };
    seedManifest('@me/a', [{ id: '@me/b' }, { id: '@me/d-opt', optional: true }]);
    seedManifest('@me/b', [{ id: '@me/c' }]);
    seedManifest('@me/c');

    const seeded: PluginSnapshot = {
      ...emptySnapshot(),
      manifests: ['@me/a', '@me/b', '@me/c'].map((id) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        manifest: JSON.parse(readFileSync(join(dirs[id], 'forgeax-plugin.json'), 'utf-8')) as any,
        layer: 'L2' as const,
        originPath: join(dirs[id], 'forgeax-plugin.json'),
        shadowedBy: [],
      })),
    };
    _setSnapshotForTests(seeded);

    const r = closureFrom('@me/a');
    expect(r.ids).toEqual(['@me/a', '@me/b', '@me/c']);
    expect(r.missing).toEqual([]);
  });

  it('closureFrom reports missing root id', () => {
    _setSnapshotForTests(emptySnapshot());
    const r = closureFrom('@me/does-not-exist');
    expect(r.ids).toEqual([]);
    expect(r.missing).toEqual(['@me/does-not-exist']);
  });

  it('exportPack with closure:true expands a single pack to include deps', async () => {
    // Same shape as the bundle closure test but with type=single and the
    // explicit opt-in flag. The resulting pack must list both ids in
    // contains[] while keeping `primary` pointed at the root.
    const hostDir = join(TMP, 'src', 'sclosure-host');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, 'forgeax-plugin.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: '@me/sclosure-host',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { en: 'Host' },
          author: { name: 't' },
          dependencies: [{ id: '@me/sclosure-dep' }],
          provides: { workbench: { id: 'sclosure:wb' } },
          entry: { backend: './h.ts' },
          compatibleWith: { 'forgeax-bus': '^1.0.0' },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(hostDir, 'h.ts'), 'export const ok = true;\n', 'utf-8');

    const depDir = join(TMP, 'src', 'sclosure-dep');
    writeMinimalPlugin(depDir, '@me/sclosure-dep');

    const seeded: PluginSnapshot = {
      ...emptySnapshot(),
      manifests: [
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          manifest: JSON.parse(readFileSync(join(depDir, 'forgeax-plugin.json'), 'utf-8')) as any,
          layer: 'L2',
          originPath: join(depDir, 'forgeax-plugin.json'),
          shadowedBy: [],
        },
      ],
    };
    _setSnapshotForTests(seeded);

    const out = join(TMP, 'sclosure.fxpack');
    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/sclosure-host', srcDir: hostDir }],
      outPath: out,
      closure: true,
      bundleMeta: { id: '@me/sclosure-host', version: '0.1.0', title: { en: 'S' } },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contains.map((c) => c.id).sort()).toEqual([
      '@me/sclosure-dep',
      '@me/sclosure-host',
    ]);
    expect(r.manifest.primary).toBe('@me/sclosure-host');
    expect(r.warnings.some((w) => w.includes('@me/sclosure-dep'))).toBe(true);
  });

  it('exportPack without closure:true still ships type=single packs as just the root', async () => {
    // Same fixture, no closure flag → single pack = single plugin (legacy
    // behaviour, locked in as a regression so default stays minimal).
    const hostDir = join(TMP, 'src', 'sclosure2-host');
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@me/sclosure2-host',
        version: '0.1.0',
        kind: 'workbench',
        displayName: { en: 'Host' },
        author: { name: 't' },
        dependencies: [{ id: '@me/whatever' }],
        provides: { workbench: { id: 'sclosure2:wb' } },
        entry: { backend: './h.ts' },
        compatibleWith: { 'forgeax-bus': '^1.0.0' },
      }),
      'utf-8',
    );
    writeFileSync(join(hostDir, 'h.ts'), 'export const ok = true;\n', 'utf-8');

    const r = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/sclosure2-host', srcDir: hostDir }],
      outPath: join(TMP, 'sclosure2.fxpack'),
      bundleMeta: { id: '@me/sclosure2-host', version: '0.1.0', title: { en: 'S' } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contains.map((c) => c.id)).toEqual(['@me/sclosure2-host']);
  });
});

describe('packs trust-ack on unsigned install', () => {
  it('installPack with userAcknowledgedUnsigned writes plugins-trust.yaml entry', async () => {
    const { readTrust, latestTrustFor } = await import('../src/packs/ledger');
    const src = join(TMP, 'src', 'unsigned-ack');
    writeMinimalPlugin(src, '@me/unsigned-ack');
    const out = join(TMP, 'unsigned-ack.fxpack');
    await exportPack({
      type: 'single',
      plugins: [{ id: '@me/unsigned-ack', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/unsigned-ack', version: '0.1.0', title: { en: 'U' } },
    });

    const destRoot = join(TMP, 'unsigned-ack-dest');
    mkdirSync(destRoot, { recursive: true });
    const r = await installPack({
      zipPath: out,
      destRoot,
      destLayer: 'L2',
      userAcknowledgedUnsigned: true,
    });
    expect(r.ok).toBe(true);

    const entries = readTrust(destRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('@me/unsigned-ack');
    expect(entries[0].decision).toBe('allow');
    expect(entries[0].signed).toBe(false);
    expect(entries[0].reason).toBe('user-ack-unsigned');

    // Without the flag, no trust entry is written.
    const dest2 = join(TMP, 'no-ack-dest');
    mkdirSync(dest2, { recursive: true });
    const r2 = await installPack({ zipPath: out, destRoot: dest2, destLayer: 'L2' });
    expect(r2.ok).toBe(true);
    expect(readTrust(dest2)).toHaveLength(0);

    // Latest helper still resolves the recorded ack.
    const latest = latestTrustFor(destRoot, '@me/unsigned-ack');
    expect(latest?.reason).toBe('user-ack-unsigned');
  });
});

describe('packs round-trip', () => {
  it('export → inspect → install yields a loadable plugin layout', async () => {
    const src = join(TMP, 'src', 'rt');
    writeMinimalPlugin(src, '@me/round-trip');
    const out = join(TMP, 'rt.fxpack');

    const exp = await exportPack({
      type: 'single',
      plugins: [{ id: '@me/round-trip', srcDir: src }],
      outPath: out,
      bundleMeta: { id: '@me/round-trip', version: '0.1.0', title: { en: 'R' } },
    });
    expect(exp.ok).toBe(true);

    const insp = await inspectPack(out);
    expect(insp.ok).toBe(true);

    const destRoot = join(TMP, 'dest');
    mkdirSync(destRoot, { recursive: true });
    const inst = await installPack({ zipPath: out, destRoot, destLayer: 'L2' });
    expect(inst.ok).toBe(true);

    // The installed plugin dir matches the source byte-for-byte on
    // forgeax-plugin.json (no transform during pack/unpack).
    const original = readFileSync(join(src, 'forgeax-plugin.json'), 'utf-8');
    const installed = readFileSync(
      join(destRoot, '.forgeax/plugins/round-trip/forgeax-plugin.json'),
      'utf-8',
    );
    expect(JSON.parse(installed)).toEqual(JSON.parse(original));
  });
});
