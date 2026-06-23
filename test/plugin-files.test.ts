/**
 * Doc 09 §2.1 — plugin-files backend (wb-plugin-author editor).
 *
 * Asserts the path-jail, extension whitelist, and size cap actually keep us
 * inside the plugin dir. The UI half of wb-plugin-author lives in the
 * interface package and is exercised in dev manually; here we pin the
 * unsafe-by-default surfaces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listPluginFiles, readPluginFile, writePluginFile } from '../src/plugins/files';

const TMP = `/tmp/forgeax-plugin-files-${process.pid}`;
const SLUG = 'demo';
const PROJ_ROOT = TMP;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, '.forgeax', 'plugins', SLUG, 'src'), { recursive: true });
  writeFileSync(
    join(TMP, '.forgeax', 'plugins', SLUG, 'forgeax-plugin.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', id: '@me/demo', kind: 'tool' }),
    'utf-8',
  );
  writeFileSync(
    join(TMP, '.forgeax', 'plugins', SLUG, 'src', 'index.ts'),
    'export const x = 1;\n',
    'utf-8',
  );
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('Doc 09 §2.1 — plugin-files backend', () => {
  it('list returns recursive entries sorted by path', () => {
    const r = listPluginFiles(PROJ_ROOT, SLUG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.entries.map((e) => e.path);
    expect(names).toContain('forgeax-plugin.json');
    expect(names).toContain('src');
    expect(names).toContain('src/index.ts');
  });

  it('read returns file content', () => {
    const r = readPluginFile(PROJ_ROOT, SLUG, 'src/index.ts');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('export const x = 1;\n');
  });

  it('write creates parent dirs + reload picks up the change', () => {
    const r = writePluginFile(PROJ_ROOT, SLUG, 'docs/README.md', '# hi\n');
    expect(r.ok).toBe(true);
    const abs = join(TMP, '.forgeax', 'plugins', SLUG, 'docs', 'README.md');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf-8')).toBe('# hi\n');
  });

  it('rejects path-traversal attempts (.. above plugin dir)', () => {
    const r = readPluginFile(PROJ_ROOT, SLUG, '../../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('rejects absolute paths', () => {
    const r = readPluginFile(PROJ_ROOT, SLUG, '/etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('rejects bad slug shapes', () => {
    const r = listPluginFiles(PROJ_ROOT, '../escape');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_slug');
  });

  it('rejects unknown extensions on write', () => {
    const r = writePluginFile(PROJ_ROOT, SLUG, 'evil.exe', 'MZ\x00');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_ext');
  });

  it('rejects oversize writes', () => {
    const huge = 'x'.repeat(300 * 1024);
    const r = writePluginFile(PROJ_ROOT, SLUG, 'big.md', huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_large');
  });

  it('rejects writes when plugin dir is missing', () => {
    const r = writePluginFile(PROJ_ROOT, 'nope', 'a.md', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});
