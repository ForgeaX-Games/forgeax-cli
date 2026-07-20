/**
 * E-02 — settings.permissions 接线的验收补强(loader 已存在并接进三 host)。
 *
 * 本套补三个既有测试未覆盖的验收点:
 *   #2 ask 规则在 acceptEdits / always-allow 命中时仍强制弹卡(engine 顺序保证);
 *   #4 /permissions 视图能看到规则来源(source)标注;
 *   E-01×E-02 协同:settings 的 Bash deny 规则对复合命令也生效(不被走私绕过)。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPermissionRulesFromSettings } from '../src/cli/permission-settings';
import { resetSettingsCache } from '../src/cli/settings';
import { hasPermissionsToUseTool } from '../src/permission/engine';
import { getPermissionRules, formatRuleView } from '../src/permission/inspect';
import { buildTool, type ToolContext } from '../src/capability/types';
import { bashTool, writeFileTool } from '../src/capability/builtin-tools/index';

afterEach(() => resetSettingsCache());

const bash = buildTool({
  name: 'Bash',
  call: async (i: unknown) => ({ data: i }),
  mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
  maxResultSizeChars: 1000,
});
const write = buildTool({
  name: 'Write',
  isReadOnly: () => false,
  isDestructive: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
  maxResultSizeChars: 1000,
});
const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as ToolContext;

function ws(project: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'fx-e02-'));
  mkdirSync(join(dir, '.forgeax'), { recursive: true });
  writeFileSync(join(dir, '.forgeax', 'settings.json'), JSON.stringify(project));
  resetSettingsCache();
  return dir;
}

describe('E-02 #2 ask rule fires even under acceptEdits / always-allow', () => {
  test('settings ask(Write) → ask even in acceptEdits mode', async () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { ask: ['Write'] } }));
    const r = await hasPermissionsToUseTool(write, { file_path: '/a.ts', content: 'x' }, ctx(), rules, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('ask');
  });

  test('settings ask(Write) → ask even when an always-allow(Write) exists', async () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { ask: ['Write'], allow: ['Write'] } }));
    const r = await hasPermissionsToUseTool(write, { file_path: '/a.ts', content: 'x' }, ctx(), rules, {
      mode: 'default',
    });
    expect(r.behavior).toBe('ask');
  });
});

describe('E-02 #4 /permissions view exposes rule source', () => {
  test('formatRuleView annotates the settings source', () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { deny: ['Bash(rm *)'] } }));
    const view = getPermissionRules(rules, 'default');
    expect(view.deny.length).toBe(1);
    const line = formatRuleView(view.deny[0]);
    expect(line).toContain('Bash(rm *)');
    expect(line).toContain('settings.permissions.deny');
  });

  test('formatRuleView on a source-less rule is just the display', () => {
    const view = getPermissionRules({ deny: [{ toolName: 'Write', behavior: 'deny' }] }, 'default');
    expect(formatRuleView(view.deny[0])).toBe('Write');
  });
});

describe('E-02 alias normalization: canonical rule names match real tool names', () => {
  // 真实 bash 工具 name='bash'(alias 'Bash');用户按 CC 习惯写 `Bash(rm *)`。
  // 规则名与工具名须经 alias 归一,否则 deny 形同虚设(live-API 复现:rm 被 Allowed)。
  test('settings deny `Bash(rm *)` denies the REAL bash tool (name=bash)', async () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { deny: ['Bash(rm *)'] } }));
    const r = await hasPermissionsToUseTool(bashTool(), { command: 'rm -rf /tmp/x' }, ctx(), rules, {
      mode: 'default',
    });
    expect(r.behavior).toBe('deny');
  });

  test('settings deny `Write` denies the REAL write_file tool (name=write_file)', async () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { deny: ['Write'] } }));
    const r = await hasPermissionsToUseTool(writeFileTool(), { file_path: '/a', content: 'x' }, ctx(), rules, {
      mode: 'default',
    });
    expect(r.behavior).toBe('deny');
  });
});

describe('E-02 × E-01 synergy: settings Bash deny catches compound commands', () => {
  test('settings deny Bash(rm *) denies `echo x && rm -rf /tmp/x`', async () => {
    const rules = loadPermissionRulesFromSettings(ws({ permissions: { deny: ['Bash(rm *)'] } }));
    const r = await hasPermissionsToUseTool(bash, { command: 'echo x && rm -rf /tmp/x' }, ctx(), rules, {
      mode: 'default',
    });
    expect(r.behavior).toBe('deny');
    expect(r.decisionReason?.type).toBe('rule');
    expect((r.decisionReason as { source?: string }).source).toBe('settings.permissions.deny');
  });
});
