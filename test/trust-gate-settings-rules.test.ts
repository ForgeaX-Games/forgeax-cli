/** 046 楔子1-补:trust-gate settings 规则叠加 单测。
 *
 *  验证决策顺序:settings deny(bypass-immune,先于 ALWAYS_ALLOW)> tier 硬 deny
 *  > R2-08 scoped(unresolvable 的 fail-closed deny 不被 settings ask 盲批绕过)
 *  > settings ask > tier ask > settings allow > tier 直放/兜底 ask。
 *  以及:不传 rules = 纯 tier 基线(零行为变化,由既有 trust-gate.test.ts 钉住)。 */
import { describe, expect, test } from 'bun:test';
import { parseRuleString, type PermissionRuleSet } from '@forgeax/types';
import { checkKernelTool } from '../src/kernel/trust-gate';

function rules(partial: Partial<Record<'deny' | 'ask' | 'allow', string[]>>): PermissionRuleSet {
  const parse = (arr: string[] | undefined, behavior: 'deny' | 'ask' | 'allow') =>
    (arr ?? []).map((s) => parseRuleString(s, behavior, `test.${behavior}`)!).filter(Boolean);
  return { deny: parse(partial.deny, 'deny'), ask: parse(partial.ask, 'ask'), allow: parse(partial.allow, 'allow') };
}

describe('checkKernelTool + settings 规则叠加', () => {
  test('settings deny:own tier 本会直放的 exec 被拒(bypass-immune)', () => {
    const d = checkKernelTool('own', 'bash', { args: { command: 'rm -rf /tmp/x' }, rules: rules({ deny: ['bash(rm *)'] }) });
    expect(d.outcome).toBe('deny');
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('test.deny');
  });

  test('settings deny 先于 ALWAYS_ALLOW(委派原语也可被显式 deny)', () => {
    const d = checkKernelTool('own', 'delegate_to_subagent', { rules: rules({ deny: ['delegate_to_subagent'] }) });
    expect(d.outcome).toBe('deny');
    // 无规则时委派原语直放(基线不变)。
    expect(checkKernelTool('own', 'delegate_to_subagent', {}).outcome).toBe('allow');
  });

  test('tier 硬 deny(imported credential)不被 settings allow 洗白', () => {
    const d = checkKernelTool('imported', 'get_secret', { rules: rules({ allow: ['get_secret'] }) });
    expect(d.outcome).toBe('deny');
  });

  test('R2-08 unresolvable fail-closed deny 不被 settings ask 翻成盲批卡', () => {
    // imported write、无 projectRoot/路径 → deny;即便有 ask 规则命中同名工具。
    const d = checkKernelTool('imported', 'write_file', { args: {}, rules: rules({ ask: ['write_file'] }) });
    expect(d.outcome).toBe('deny');
  });

  test('settings ask:own tier 本会直放的读操作被强制弹卡', () => {
    const d = checkKernelTool('own', 'read_file', { args: { path: '/tmp/a' }, rules: rules({ ask: ['read_file'] }) });
    expect(d.outcome).toBe('ask');
    expect(d.reason).toContain('test.ask');
  });

  test('settings allow:imported 的未知能力工具(基线兜底 ask)有规则背书 → 直放', () => {
    expect(checkKernelTool('imported', 'balance_resim', {}).outcome).toBe('ask'); // 基线
    const d = checkKernelTool('imported', 'balance_resim', { rules: rules({ allow: ['balance_resim'] }) });
    expect(d.outcome).toBe('allow');
  });

  test('settings allow 不越过 tier ask(imported exec 仍弹卡→…settings allow 在 tier ask 之后)', () => {
    const d = checkKernelTool('imported', 'bash', { args: { command: 'git status' }, rules: rules({ allow: ['bash(git *)'] }) });
    expect(d.outcome).toBe('ask'); // imported exec 的 tier ask 先于 settings allow(更严者胜)
  });

  test('无 rules / 空 rules = 纯 tier 基线(零行为变化)', () => {
    expect(checkKernelTool('own', 'bash', { args: { command: 'ls' } }).outcome).toBe('allow');
    expect(
      checkKernelTool('own', 'bash', { args: { command: 'ls' }, rules: { deny: [], ask: [], allow: [] } }).outcome,
    ).toBe('allow');
  });
});
