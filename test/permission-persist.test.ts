/**
 * 权限规则项目级持久化测试(PERM persist)。
 *
 * 覆盖:
 *   1) saveAllowRules → loadAllowRules 往返;behavior 恒 allow、source 标 project-permissions。
 *   2) 带 content 的规则往返保真;去重。
 *   3) 无文件 → [];坏 JSON → [](fail-safe,不放宽权限)。
 *   4) 未知/非法条目被跳过。
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAllowRules, saveAllowRules, permissionsFilePath } from '../src/permission/persist';
import type { PermissionRule } from '../src/permission/rules';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'perm-persist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('permission persist', () => {
  test('save → load round-trips whole-tool allow rules', () => {
    const rules: PermissionRule[] = [{ toolName: 'bash', behavior: 'allow', source: 'tui-allow-always' }];
    saveAllowRules(dir, rules);
    const loaded = loadAllowRules(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.toolName).toBe('bash');
    expect(loaded[0]!.behavior).toBe('allow');
    expect(loaded[0]!.source).toBe('project-permissions');
    expect(loaded[0]!.content).toBeUndefined();
  });

  test('content-scoped rule round-trips and dedupes', () => {
    saveAllowRules(dir, [
      { toolName: 'bash', content: 'git *', behavior: 'allow' },
      { toolName: 'bash', content: 'git *', behavior: 'allow' }, // dup
      { toolName: 'write_file', behavior: 'allow' },
    ]);
    const loaded = loadAllowRules(dir);
    expect(loaded).toHaveLength(2);
    const bash = loaded.find((r) => r.toolName === 'bash');
    expect(bash?.content).toBe('git *');
  });

  test('missing file → empty (fail-safe)', () => {
    expect(loadAllowRules(dir)).toEqual([]);
  });

  test('corrupt JSON → empty (fail-safe, never widens permission)', () => {
    mkdirSync(join(dir, '.forgeax'), { recursive: true });
    writeFileSync(permissionsFilePath(dir), '{ not json', 'utf8');
    expect(loadAllowRules(dir)).toEqual([]);
  });

  test('malformed entries are skipped', () => {
    mkdirSync(join(dir, '.forgeax'), { recursive: true });
    writeFileSync(
      permissionsFilePath(dir),
      JSON.stringify({ version: 1, allow: [{ toolName: '' }, { nope: 1 }, 'x', { toolName: 'bash' }] }),
      'utf8',
    );
    const loaded = loadAllowRules(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.toolName).toBe('bash');
  });
});
