/**
 * E-05 — 权限升级护栏(bypass lock + --yes 防自己)。
 * 覆盖:root 拒绝 --yes / bypass;settings killswitch 拒绝 bypass;非 root 常态放行。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardYes, guardBypassMode, isRoot } from '../src/cli/escalation-guard';
import { resetSettingsCache } from '../src/cli/settings';

const origGetuid = (process as { getuid?: () => number }).getuid;
function setUid(uid: number | undefined): void {
  (process as { getuid?: () => number }).getuid = uid === undefined ? undefined : () => uid;
}
afterEach(() => {
  (process as { getuid?: () => number }).getuid = origGetuid;
  resetSettingsCache();
});

describe('E-05 escalation guard', () => {
  test('root:拒绝 --yes 与 bypass', () => {
    setUid(0);
    resetSettingsCache();
    expect(guardYes().allowed).toBe(false);
    expect(guardYes().reason).toMatch(/root/i);
    expect(guardBypassMode('/tmp').allowed).toBe(false);
  });

  test('非 root:--yes 放行', () => {
    setUid(1000);
    expect(guardYes().allowed).toBe(true);
  });

  test('settings disableBypassPermissionsMode:非 root 也拒绝 bypass', () => {
    setUid(1000);
    const dir = mkdtempSync(join(tmpdir(), 'esc-'));
    try {
      mkdirSync(join(dir, '.forgeax'), { recursive: true });
      writeFileSync(join(dir, '.forgeax', 'settings.json'), JSON.stringify({ disableBypassPermissionsMode: true }));
      resetSettingsCache();
      const v = guardBypassMode(dir);
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/disabled by settings/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('permissions.disableBypassPermissionsMode 亦生效', () => {
    setUid(1000);
    const dir = mkdtempSync(join(tmpdir(), 'esc2-'));
    try {
      mkdirSync(join(dir, '.forgeax'), { recursive: true });
      writeFileSync(join(dir, '.forgeax', 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }));
      resetSettingsCache();
      expect(guardBypassMode(dir).allowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非 root + 无 killswitch:bypass 放行', () => {
    setUid(1000);
    const dir = mkdtempSync(join(tmpdir(), 'esc3-'));
    try {
      resetSettingsCache();
      expect(guardBypassMode(dir).allowed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isRoot 反映 getuid', () => {
    setUid(0);
    expect(isRoot()).toBe(true);
    setUid(1000);
    expect(isRoot()).toBe(false);
  });
});
