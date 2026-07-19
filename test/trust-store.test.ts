/**
 * trust 存储语义(src/cli/trust.ts):
 *   - 祖先遍历:信任父目录 → 子目录(任意深)通过;兄弟目录不通过。
 *   - fail closed:缺文件 / 坏 JSON / 形状不对 → 未信任,永不抛。
 *   - persistTrust 幂等 + merge(多项目共存,重复接受不重复条目)。
 *   - FORGEAX_CONFIG_DIR 隔离(测试各用独立临时根)。
 *   - symlink realpath 归一:经软链进入同一目录不重复弹。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrusted, persistTrust, projectsFilePath } from '../src/cli/trust';

let configDir: string;
let work: string;
let prevEnv: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'fxc-trust-cfg-'));
  work = mkdtempSync(join(tmpdir(), 'fxc-trust-work-'));
  prevEnv = process.env.FORGEAX_CONFIG_DIR;
  process.env.FORGEAX_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.FORGEAX_CONFIG_DIR;
  else process.env.FORGEAX_CONFIG_DIR = prevEnv;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('trust store', () => {
  test('untrusted by default (no projects.json)', () => {
    expect(isTrusted(work)).toBe(false);
  });

  test('persistTrust → isTrusted; ancestor trust inherits to subdirs', () => {
    const child = join(work, 'a', 'b', 'c');
    mkdirSync(child, { recursive: true });
    persistTrust(work);
    expect(isTrusted(work)).toBe(true);
    expect(isTrusted(child)).toBe(true); // 向下继承(祖先遍历)
  });

  test('sibling directory is NOT trusted', () => {
    const a = join(work, 'a');
    const b = join(work, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    persistTrust(a);
    expect(isTrusted(a)).toBe(true);
    expect(isTrusted(b)).toBe(false);
  });

  test('corrupt projects.json → fail closed (untrusted, no throw)', () => {
    writeFileSync(projectsFilePath(), '{ not json', 'utf8');
    expect(isTrusted(work)).toBe(false);
    // 坏文件下 persistTrust 也能自愈(读 {} → 覆盖写)。
    persistTrust(work);
    expect(isTrusted(work)).toBe(true);
  });

  test('wrong-shape projects.json → fail closed', () => {
    writeFileSync(projectsFilePath(), JSON.stringify({ projects: ['nope'] }), 'utf8');
    expect(isTrusted(work)).toBe(false);
  });

  test('persistTrust is idempotent and merges across projects', () => {
    const a = join(work, 'a');
    const b = join(work, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    persistTrust(a);
    persistTrust(a); // 幂等:同目录重复接受不产生第二条目
    persistTrust(b); // merge:不丢已有条目
    const file = JSON.parse(readFileSync(projectsFilePath(), 'utf8')) as {
      projects: Record<string, { trusted: boolean }>;
    };
    expect(Object.keys(file.projects).length).toBe(2);
    expect(isTrusted(a)).toBe(true);
    expect(isTrusted(b)).toBe(true);
  });

  test('symlink resolves to realpath (same dir via link = trusted once)', () => {
    const real = join(work, 'real');
    mkdirSync(real, { recursive: true });
    const link = join(work, 'link');
    symlinkSync(real, link);
    persistTrust(real);
    expect(isTrusted(link)).toBe(true); // 经软链进入 → realpath 归一命中
  });
});
