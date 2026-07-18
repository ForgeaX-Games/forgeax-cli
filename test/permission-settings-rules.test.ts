/** 046 楔子1-补 + 楔子3:settings.permissions 分层 loader + 独立求值器 单测。
 *
 *  覆盖:三层 set-union(deny 不被高层吞)/ fail-safe(缺文件、坏 JSON、坏条目)/
 *  mtime 缓存翻新 / evaluateSettingsRules 的 deny>ask>allow 顺序与 shell 结构感知。
 *  HOME 重定向到临时目录 —— 不读真用户 ~/.forgeax(测试封闭性)。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSettingsPermissionRulesCache,
  evaluateSettingsRules,
  loadSettingsPermissionRules,
  ruleLabel,
} from '../src/api/lib/permission-settings';

let home: string;
let project: string;
let savedHome: string | undefined;

function writeSettings(dir: string, file: string, permissions: unknown): void {
  mkdirSync(join(dir, '.forgeax'), { recursive: true });
  writeFileSync(join(dir, '.forgeax', file), JSON.stringify({ permissions }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fx-perm-home-'));
  project = mkdtempSync(join(tmpdir(), 'fx-perm-proj-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  clearSettingsPermissionRulesCache();
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  clearSettingsPermissionRulesCache();
});

describe('loadSettingsPermissionRules — 分层 set-union', () => {
  test('user + project + local 三层 deny 全部生效(union,不覆盖)', () => {
    writeSettings(home, 'settings.json', { deny: ['Bash(rm *)'] });
    writeSettings(project, 'settings.json', { deny: ['Bash(git push*)'], allow: ['Read'] });
    writeSettings(project, 'settings.local.json', { ask: ['Bash(curl *)'] });
    const rules = loadSettingsPermissionRules(project);
    expect(rules.deny.map((r) => r.content)).toEqual(['rm *', 'git push*']);
    expect(rules.ask).toHaveLength(1);
    expect(rules.allow).toHaveLength(1);
    // source 标注携带层名(审计/decisionReason 可读)。
    expect(rules.deny[0].source).toBe('settings(user).permissions.deny');
    expect(rules.deny[1].source).toBe('settings(project).permissions.deny');
  });

  test('同形规则跨层去重(以先出现层为准)', () => {
    writeSettings(home, 'settings.json', { deny: ['Bash(rm *)'] });
    writeSettings(project, 'settings.json', { deny: ['Bash(rm *)'] });
    expect(loadSettingsPermissionRules(project).deny).toHaveLength(1);
  });

  test('缺文件 / 坏 JSON / 非法条目 → fail-safe 空桶或丢弃,永不抛', () => {
    // 全缺:三空桶。
    expect(loadSettingsPermissionRules(project)).toEqual({ deny: [], ask: [], allow: [] });
    clearSettingsPermissionRulesCache();
    // 坏 JSON 层被跳过,好层照常。
    mkdirSync(join(project, '.forgeax'), { recursive: true });
    writeFileSync(join(project, '.forgeax', 'settings.json'), '{oops');
    writeSettings(home, 'settings.json', { deny: ['Bash(rm *)', 42, 'Bad('] });
    const rules = loadSettingsPermissionRules(project);
    expect(rules.deny).toHaveLength(1);
  });

  test('mtime 缓存:文件变更后翻新', async () => {
    writeSettings(project, 'settings.json', { deny: ['Bash(rm *)'] });
    expect(loadSettingsPermissionRules(project).deny).toHaveLength(1);
    // 确保 mtime 前进(文件系统 mtime 粒度)。
    await new Promise((r) => setTimeout(r, 20));
    writeSettings(project, 'settings.json', { deny: ['Bash(rm *)', 'Write'] });
    expect(loadSettingsPermissionRules(project).deny).toHaveLength(2);
  });
});

describe('evaluateSettingsRules — deny > ask > allow', () => {
  test('顺序与 shell 结构感知(走私防护)', () => {
    writeSettings(project, 'settings.json', {
      deny: ['Bash(rm *)'],
      ask: ['Bash(git push*)'],
      allow: ['Bash(git *)'],
    });
    const rules = loadSettingsPermissionRules(project);
    // deny 命中复合命令的任一子命令。
    expect(evaluateSettingsRules(rules, 'Bash', { command: 'echo x && rm -rf /' })?.behavior).toBe('deny');
    // ask 在 allow 之前。
    expect(evaluateSettingsRules(rules, 'Bash', { command: 'git push origin main' })?.behavior).toBe('ask');
    // allow:全子命令命中才成立。
    expect(evaluateSettingsRules(rules, 'Bash', { command: 'git status' })?.behavior).toBe('allow');
    expect(evaluateSettingsRules(rules, 'Bash', { command: 'git status && curl x' })).toBeUndefined();
    // 未命中 → undefined(调用方走原有流程)。
    expect(evaluateSettingsRules(rules, 'Write', { file_path: '/tmp/x' })).toBeUndefined();
  });

  test('ruleLabel 人读标签', () => {
    writeSettings(project, 'settings.json', { deny: ['Bash(rm *)'] });
    const rules = loadSettingsPermissionRules(project);
    expect(ruleLabel(rules.deny[0])).toBe('settings(project).permissions.deny "Bash(rm *)"');
  });
});
