/**
 * E-01 — Bash 复合命令走私(安全 bug)。
 *
 * 平铺 glob(`*`→`.*`)对整命令串匹配,没有 shell 结构感知,导致:
 *   1. allow 走私:`Bash(git *)` 放行 `git status && rm -rf /`;
 *   2. deny 绕过:`Bash(rm *)` 拦不住 `echo x && rm -rf /` / `FOO=1 rm -rf /`;
 *   3. 命令替换 `$()` / 子 shell 无识别。
 *
 * 修复后语义(不对称匹配 + shell 拆分):
 *   - allow 需所有子命令各自命中 allow 规则(env 不剥离);
 *   - deny/ask 任一子命令命中即触发(deny/ask 前剥 env 前缀);
 *   - 含 $()/反引号/子 shell 且有内容级规则 → allow 不成立 → 落 ask。
 */
import { test, expect, describe } from 'bun:test';
import { matchRule, type PermissionRule } from '../src/permission/rules';

const allow = (content?: string): PermissionRule[] => [{ toolName: 'Bash', content, behavior: 'allow' }];
const deny = (content?: string): PermissionRule[] => [{ toolName: 'Bash', content, behavior: 'deny' }];

describe('E-01 allow rule must not smuggle compound commands', () => {
  test('Bash(git *) allow does NOT cover `git status && rm -rf /`', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git status && rm -rf /' })).toBeUndefined();
  });
  test('Bash(git *) allow does NOT cover `git status; rm -rf /`', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git status; rm -rf /' })).toBeUndefined();
  });
  test('Bash(git *) allow does NOT cover `git status | sh`', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git status | sh' })).toBeUndefined();
  });
  test('Bash(git *) allow STILL covers a plain `git status` (zero-regression)', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git status' })).toBeDefined();
  });
  test('all sub-commands covered by allow set → allowed', () => {
    const rules: PermissionRule[] = [
      { toolName: 'Bash', content: 'git *', behavior: 'allow' },
      { toolName: 'Bash', content: 'ls *', behavior: 'allow' },
    ];
    expect(matchRule(rules, 'Bash', { command: 'git status && ls -al' })).toBeDefined();
  });
});

describe('E-01 deny rule must not be bypassed by compound / env prefix', () => {
  test('Bash(rm *) deny catches `echo x && rm -rf /tmp/x`', () => {
    expect(matchRule(deny('rm *'), 'Bash', { command: 'echo x && rm -rf /tmp/x' })).toBeDefined();
  });
  test('Bash(rm *) deny catches `FOO=1 rm -rf /tmp/x` (env prefix stripped)', () => {
    expect(matchRule(deny('rm *'), 'Bash', { command: 'FOO=1 rm -rf /tmp/x' })).toBeDefined();
  });
  test('Bash(rm *) deny catches `a=1 b=2 rm -rf x`', () => {
    expect(matchRule(deny('rm *'), 'Bash', { command: 'a=1 b=2 rm -rf x' })).toBeDefined();
  });
});

describe('E-01 command substitution / subshell forces non-allow (→ ask)', () => {
  test('`$()` prevents allow coverage even if outer matches', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git log $(rm -rf /)' })).toBeUndefined();
  });
  test('backtick prevents allow coverage', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: 'git log `rm -rf /`' })).toBeUndefined();
  });
  test('subshell prevents allow coverage', () => {
    expect(matchRule(allow('git *'), 'Bash', { command: '(rm -rf /)' })).toBeUndefined();
  });
});

describe('E-01 zero-regression on whole-tool + non-shell rules', () => {
  test('whole-tool Bash allow still matches anything', () => {
    expect(matchRule(allow(undefined), 'Bash', { command: 'anything && whatever' })).toBeDefined();
  });
  test('non-shell content rule unchanged (Write file_path glob)', () => {
    const rules: PermissionRule[] = [{ toolName: 'Write', content: '/src/*', behavior: 'deny' }];
    expect(matchRule(rules, 'Write', { file_path: '/src/a.ts' })).toBeDefined();
    expect(matchRule(rules, 'Write', { file_path: '/other/a.ts' })).toBeUndefined();
  });
});
