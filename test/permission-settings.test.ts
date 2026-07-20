/**
 * 楔子1 · 046 —— settings.permissions → PermissionRuleSet loader 测试。
 *
 * 覆盖:纯解析(deny/ask/allow、丢非法/非字符串条目、桶容错)+ 分层落盘读取
 * (project<local 合并)+ 端到端(载出的 deny 经 engine 真拒)。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rulesFromPermissionsSetting,
  loadPermissionRulesFromSettings,
  parseDefaultModeFromPermissionsSetting,
  loadDefaultPermissionModeFromSettings,
} from '../src/cli/permission-settings';
import { PERMISSION_MODES } from '../src/permission/inspect';
import { resetSettingsCache } from '../src/cli/settings';
import { hasPermissionsToUseTool } from '../src/permission/engine';
import { buildTool, type ToolContext, type PermissionResult } from '../src/capability/types';

afterEach(() => resetSettingsCache());

function fakeTool(name: string, check?: (i: unknown, c: ToolContext) => Promise<PermissionResult>) {
  return buildTool({
    name,
    ...(check ? { checkPermissions: check } : {}),
    call: async (input: unknown) => ({ data: input }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}
const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as ToolContext;

/** 落一个临时 workspace,写 .forgeax/settings.json(+ 可选 .local)。返回 cwd。 */
function tmpWorkspace(project: unknown, local?: unknown): string {
  const ws = mkdtempSync(join(tmpdir(), 'fx-046-'));
  mkdirSync(join(ws, '.forgeax'), { recursive: true });
  writeFileSync(join(ws, '.forgeax', 'settings.json'), JSON.stringify(project));
  if (local !== undefined) writeFileSync(join(ws, '.forgeax', 'settings.local.json'), JSON.stringify(local));
  resetSettingsCache();
  return ws;
}

describe('rulesFromPermissionsSetting — 纯解析', () => {
  test('deny/ask/allow 三桶各自解析成规则(带 source)', () => {
    const set = rulesFromPermissionsSetting({
      deny: ['Bash(rm -rf *)'],
      ask: ['Bash(git push*)'],
      allow: ['Read', 'Bash(git *)'],
    });
    expect(set.deny).toEqual([
      { toolName: 'Bash', content: 'rm -rf *', behavior: 'deny', source: 'settings.permissions.deny' },
    ]);
    expect(set.ask).toEqual([
      { toolName: 'Bash', content: 'git push*', behavior: 'ask', source: 'settings.permissions.ask' },
    ]);
    expect(set.allow).toEqual([
      { toolName: 'Read', behavior: 'allow', source: 'settings.permissions.allow' },
      { toolName: 'Bash', content: 'git *', behavior: 'allow', source: 'settings.permissions.allow' },
    ]);
  });

  test('丢弃非字符串条目 + 形状非法条目(parseRuleString→null),不抛', () => {
    const set = rulesFromPermissionsSetting({
      deny: ['Write', 42, null, { toolName: 'X' }, 'Bash(unclosed', '   '],
    });
    // 仅 'Write' 有效;其余(数字/null/对象/未闭合括号/空白)全丢。
    expect(set.deny).toEqual([{ toolName: 'Write', behavior: 'deny', source: 'settings.permissions.deny' }]);
    expect(set.ask).toEqual([]);
    expect(set.allow).toEqual([]);
  });

  test('非数组桶 / 非对象 permissions / 缺省 → 三空桶(fail-safe)', () => {
    const empty = { deny: [], ask: [], allow: [] };
    expect(rulesFromPermissionsSetting({ deny: 'Write' })).toEqual(empty); // 桶不是数组
    expect(rulesFromPermissionsSetting(null)).toEqual(empty);
    expect(rulesFromPermissionsSetting(undefined)).toEqual(empty);
    expect(rulesFromPermissionsSetting(['Bash'])).toEqual(empty); // 数组不是对象
    expect(rulesFromPermissionsSetting('nope')).toEqual(empty);
    expect(rulesFromPermissionsSetting({})).toEqual(empty); // 无 permissions 键
  });
});

describe('loadPermissionRulesFromSettings — 分层落盘', () => {
  test('从 project settings 读出 permissions', () => {
    const ws = tmpWorkspace({ permissions: { deny: ['Bash(rm -rf *)'] } });
    const set = loadPermissionRulesFromSettings(ws);
    expect(set.deny.map((r) => r.content)).toEqual(['rm -rf *']);
  });

  test('local 覆盖 project(数组整替换,与 settings 读合并语义一致)', () => {
    // project deny=[A], local deny=[B] → 深合并对数组做并集去重(getMergedSettings 语义)。
    const ws = tmpWorkspace(
      { permissions: { deny: ['Bash(a*)'] } },
      { permissions: { deny: ['Bash(b*)'] } },
    );
    const set = loadPermissionRulesFromSettings(ws);
    const contents = set.deny.map((r) => r.content).sort();
    expect(contents).toEqual(['a*', 'b*']);
  });

  test('无 .forgeax/settings.json → 三空桶(不抛)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'fx-046-empty-'));
    resetSettingsCache();
    expect(loadPermissionRulesFromSettings(ws)).toEqual({ deny: [], ask: [], allow: [] });
  });
});

describe('permissions.defaultMode — 三态解析', () => {
  test('未配置(无 permissions / 无 defaultMode 键 / 非对象)→ unset', () => {
    expect(parseDefaultModeFromPermissionsSetting(undefined)).toEqual({ kind: 'unset' });
    expect(parseDefaultModeFromPermissionsSetting(null)).toEqual({ kind: 'unset' });
    expect(parseDefaultModeFromPermissionsSetting('plan')).toEqual({ kind: 'unset' });
    expect(parseDefaultModeFromPermissionsSetting(['plan'])).toEqual({ kind: 'unset' });
    expect(parseDefaultModeFromPermissionsSetting({ deny: ['Write'] })).toEqual({ kind: 'unset' });
  });

  test('全部合法模式 → valid', () => {
    for (const m of PERMISSION_MODES) {
      expect(parseDefaultModeFromPermissionsSetting({ defaultMode: m })).toEqual({ kind: 'valid', mode: m });
    }
  });

  test('配置了但非法(大小写错 / 未知串 / null / 数字)→ invalid,原值透出', () => {
    for (const bad of ['DEFAULT', 'bogus', '', null, 42]) {
      expect(parseDefaultModeFromPermissionsSetting({ defaultMode: bad })).toEqual({ kind: 'invalid', value: bad });
    }
  });

  test('分层落盘:local 的 defaultMode 覆盖 project(标量覆盖语义)', () => {
    const ws = tmpWorkspace(
      { permissions: { defaultMode: 'plan' } },
      { permissions: { defaultMode: 'acceptEdits' } },
    );
    expect(loadDefaultPermissionModeFromSettings(ws)).toEqual({ kind: 'valid', mode: 'acceptEdits' });
  });

  test('defaultMode 与规则桶互不影响(同一 permissions 段)', () => {
    const ws = tmpWorkspace({ permissions: { defaultMode: 'plan', deny: ['Bash(rm -rf *)'] } });
    expect(loadDefaultPermissionModeFromSettings(ws)).toEqual({ kind: 'valid', mode: 'plan' });
    expect(loadPermissionRulesFromSettings(ws).deny.map((r) => r.content)).toEqual(['rm -rf *']);
  });

  test('无 settings 文件 → unset(不抛)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'fx-defaultmode-empty-'));
    resetSettingsCache();
    expect(loadDefaultPermissionModeFromSettings(ws)).toEqual({ kind: 'unset' });
  });
});

describe('端到端 — 载出的规则经 engine 生效', () => {
  test('settings.deny 命中 → hasPermissionsToUseTool 判 deny', async () => {
    const ws = tmpWorkspace({ permissions: { deny: ['Bash(rm -rf *)'], ask: ['Bash(git push*)'] } });
    const rules = loadPermissionRulesFromSettings(ws);
    const bash = fakeTool('Bash');

    const denied = await hasPermissionsToUseTool(bash, { command: 'rm -rf /' }, ctx(), rules, { mode: 'default' });
    expect(denied.behavior).toBe('deny');

    const asked = await hasPermissionsToUseTool(bash, { command: 'git push origin main' }, ctx(), rules, { mode: 'default' });
    expect(asked.behavior).toBe('ask');

    // 未命中任何规则的命令:不被 settings 规则拦(落引擎默认 passthrough,非 deny)。
    const other = await hasPermissionsToUseTool(bash, { command: 'ls -la' }, ctx(), rules, { mode: 'default' });
    expect(other.behavior).not.toBe('deny');
  });
});
