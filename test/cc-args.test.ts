/**
 * cc-profile buildCcArgs —— `--tools/--disallowedTools` + `--system-prompt(-file)` 翻译单测。
 *
 * 背景:R4-13 审计补两类外控能力——工具面(toolPolicy → --tools/--disallowedTools)与
 * 系统提示词模式(ComposedPrompt.mode → --system-prompt-file vs --append-system-prompt-file)。
 * 本文件钉住 cc-profile 的 argv 翻译,防回归。所有 CC-ism 锁在 cc-profile。
 */
import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import type { TurnRequest, ComposedPrompt } from '../../agent-runtime/src/contract';
import { buildCcArgs } from '../src/kernel/cc-profile';

const ROOT = tmpdir();

function req(over: { systemPrompt?: Partial<ComposedPrompt> } & Partial<Omit<TurnRequest, 'systemPrompt'>> = {}): TurnRequest {
  const { systemPrompt, ...rest } = over;
  return {
    session: { threadId: '', agentId: 'forge' },
    input: { text: 'hello' },
    systemPrompt: { charter: 'CHARTER', persona: '', ...(systemPrompt ?? {}) },
    tools: [],
    budget: {},
    ...rest,
  } as TurnRequest;
}

/** 取变长 flag 后的值序列(到下一个 `--flag` 或末尾为止)。 */
function valuesAfter(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    if (args[j].startsWith('--')) break;
    out.push(args[j]);
  }
  return out;
}

describe('cc-profile — systemPrompt mode', () => {
  test('缺省 ⇒ --append-system-prompt-file(保留内核默认身份)', () => {
    const args = buildCcArgs(req(), ROOT, []);
    expect(args).toContain('--append-system-prompt-file');
    expect(args).not.toContain('--system-prompt-file');
  });

  test("mode:'replace' ⇒ --system-prompt-file(完全替换)", () => {
    const args = buildCcArgs(req({ systemPrompt: { charter: 'C', mode: 'replace' } }), ROOT, []);
    expect(args).toContain('--system-prompt-file');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).not.toContain('--append-system-prompt');
  });

  test("mode:'append' 显式 ⇒ --append-system-prompt-file", () => {
    const args = buildCcArgs(req({ systemPrompt: { charter: 'C', mode: 'append' } }), ROOT, []);
    expect(args).toContain('--append-system-prompt-file');
    expect(args).not.toContain('--system-prompt-file');
  });

  test('临时文件写失败 ⇒ 降级回 inline --append-system-prompt(不丢身份)', () => {
    // key 带 '/' → tmpdir/forgeax-kernel-sysprompt-bad/key.txt 的父目录不存在 → 写失败 → 降级。
    const args = buildCcArgs(req({ hostSessionId: 'bad/key', systemPrompt: { charter: 'C', mode: 'replace' } }), ROOT, []);
    expect(args).toContain('--append-system-prompt');
    expect(args).not.toContain('--system-prompt-file');
    expect(args).not.toContain('--append-system-prompt-file');
    // 降级后 system prompt 文本紧随 flag。
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('C');
  });
});

describe('cc-profile — toolPolicy', () => {
  test('缺省 ⇒ 不发 --tools / --disallowedTools(零回归)', () => {
    const args = buildCcArgs(req(), ROOT, []);
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--disallowedTools');
  });

  test('allow ⇒ --tools 逗号分隔单值', () => {
    const args = buildCcArgs(req({ toolPolicy: { allow: ['Read', 'Grep'] } }), ROOT, []);
    const i = args.indexOf('--tools');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('Read,Grep');
  });

  test('deny ⇒ --disallowedTools 变长展开', () => {
    const args = buildCcArgs(req({ toolPolicy: { deny: ['Bash', 'Write'] } }), ROOT, []);
    expect(args).toContain('--disallowedTools');
    expect(valuesAfter(args, '--disallowedTools')).toEqual(['Bash', 'Write']);
  });

  test('allow+deny 同存', () => {
    const args = buildCcArgs(req({ toolPolicy: { allow: ['Read'], deny: ['Bash'] } }), ROOT, []);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read');
    expect(valuesAfter(args, '--disallowedTools')).toEqual(['Bash']);
  });

  test('变长 --disallowedTools 不吞末尾位置参数 message', () => {
    const args = buildCcArgs(req({ input: { text: 'PROMPT_MSG' }, toolPolicy: { deny: ['Bash'] } }), ROOT, []);
    // message 是最后一个 arg,且不被并进 disallowedTools(后续有 --*-system-prompt* flag 终止变长)。
    expect(args[args.length - 1]).toBe('PROMPT_MSG');
    expect(valuesAfter(args, '--disallowedTools')).toEqual(['Bash']);
  });

  test('空/全空白项被过滤', () => {
    const args = buildCcArgs(req({ toolPolicy: { allow: ['', '  '], deny: [''] } }), ROOT, []);
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--disallowedTools');
  });
});

describe('cc-profile — budget 硬闸', () => {
  test('缺省 budget:{} ⇒ 不发 --max-turns/--max-budget-usd', () => {
    const args = buildCcArgs(req(), ROOT, []);
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
  });

  test('maxTurns/maxBudgetUsd ⇒ 对应 flag', () => {
    const args = buildCcArgs(req({ budget: { maxTurns: 3, maxBudgetUsd: 1.5 } }), ROOT, []);
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('1.5');
  });

  test('非正值被忽略', () => {
    const args = buildCcArgs(req({ budget: { maxTurns: 0, maxBudgetUsd: -1 } }), ROOT, []);
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
  });
});

describe('cc-profile — fallback-model', () => {
  test('缺省 ⇒ 不发', () => {
    expect(buildCcArgs(req(), ROOT, [])).not.toContain('--fallback-model');
  });

  test('fallbackModels ⇒ --fallback-model 逗号链', () => {
    const args = buildCcArgs(req({ fallbackModels: ['sonnet', 'haiku'] }), ROOT, []);
    expect(args[args.indexOf('--fallback-model') + 1]).toBe('sonnet,haiku');
  });
});

describe('cc-profile — hermetic 隔离(仅 imported)', () => {
  test("trustTier:'imported' ⇒ --strict-mcp-config + --setting-sources ''", () => {
    const args = buildCcArgs(req({ trustTier: 'imported' }), ROOT, []);
    expect(args).toContain('--strict-mcp-config');
    const i = args.indexOf('--setting-sources');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(''); // 空值 = 加载零来源(真二进制已验接受)
  });

  test("trustTier:'own' ⇒ 不隔离(零回归)", () => {
    const args = buildCcArgs(req({ trustTier: 'own' }), ROOT, []);
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--setting-sources');
  });

  test('缺省 trustTier ⇒ 不隔离', () => {
    const args = buildCcArgs(req(), ROOT, []);
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--setting-sources');
  });
});
