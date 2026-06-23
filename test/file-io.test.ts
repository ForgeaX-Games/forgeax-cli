import { describe, test, expect } from 'bun:test';
import { resolve } from 'path';
import { readFileSafe, writeFileSafe } from '../src/api/lib/io';

// readFileSafe distinguishes 3 outcomes by thrown message (tick 352):
//   - missing path → 'not found'
//   - directory path → 'is a directory — use GET /api/files/tree?root=<path>'
//   - regular file → resolved FileInfo
// Locking this so the /api/files handler can keep mapping the dir case
// to a 400 + actionable hint, the missing case to a 404, and a real read
// to 200.
const TEST_DIR = resolve(import.meta.dir);
const SELF_FILE = resolve(TEST_DIR, 'file-io.test.ts');
const MISSING = resolve(TEST_DIR, 'nope-this-file-doesnt-exist.txt');

describe('readFileSafe — dir/missing/file disambiguation', () => {
  test('regular file → resolves with FileInfo { path, content, size, mtime }', async () => {
    const info = await readFileSafe(SELF_FILE, 'test/file-io.test.ts');
    expect(info.path).toBe('test/file-io.test.ts');
    expect(info.content).toContain('readFileSafe — dir/missing/file');
    expect(info.size).toBeGreaterThan(0);
    expect(info.mtime).toBeGreaterThan(0);
  });

  test('missing path → throws "not found"', async () => {
    await expect(readFileSafe(MISSING, 'test/missing.txt')).rejects.toThrow('not found');
  });

  test('directory path → throws "is a directory — use GET /api/files/tree?root=<path>"', async () => {
    await expect(readFileSafe(TEST_DIR, 'test')).rejects.toThrow(
      'is a directory — use GET /api/files/tree?root=<path>',
    );
  });
});

describe('writeFileSafe — refuses to overwrite an existing directory', () => {
  test('target=directory → throws structured "target path is a directory" (tick 360)', async () => {
    // Trying to write file content over an existing directory used to
    // surface a raw EISDIR via a 500. Now writeFileSafe stats first and
    // throws a structured message the route can map to a clear 400.
    await expect(writeFileSafe(TEST_DIR, 'hi')).rejects.toThrow(
      'target path is a directory — cannot write file content over it',
    );
  });
});
