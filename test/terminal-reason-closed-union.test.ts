/**
 * B-01 — TerminalReason / ContinueReason 闭合 union 无幽灵成员。
 *
 * 闭合 union 的价值 = 「读者看到 union 即知全部可能状态」。幽灵成员(声明了但
 * loop 里零产生位点)违反该不变量,且让下游消费者为不可达分支买单。
 *
 * 本测试是防漂移守卫:解析 types.ts 里声明的每个 union 成员,断言它在
 * src/agent/ 的其它文件里至少有一个产生位点(字符串字面量出现)。任何未来
 * 新增的幽灵成员都会让本测试变红。
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentDirUrl = new URL('../src/agent/', import.meta.url);
const agentDir = fileURLToPath(agentDirUrl);

const typesSrc = readFileSync(fileURLToPath(new URL('types.ts', agentDirUrl)), 'utf8');

// 所有产生位点来源:src/agent/ 下除 types.ts 外的全部 .ts(排除测试)。
const producerSrc = readdirSync(agentDir)
  .filter((f) => f.endsWith('.ts') && f !== 'types.ts' && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(`${agentDir}${f}`, 'utf8'))
  .join('\n');

function parseUnionMembers(src: string, typeName: string): string[] {
  const re = new RegExp(`export type ${typeName} =([\\s\\S]*?);`, 'm');
  const body = re.exec(src)?.[1] ?? '';
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('B-01 TerminalReason is a closed union (no ghost members)', () => {
  const members = parseUnionMembers(typesSrc, 'TerminalReason');

  test('union is non-empty and parsed', () => {
    expect(members.length).toBeGreaterThan(5);
  });

  test('every TerminalReason member has a producer site in src/agent', () => {
    const ghosts = members.filter((m) => !producerSrc.includes(`'${m}'`));
    expect(ghosts).toEqual([]);
  });

  test('removed ghosts are absent from the union', () => {
    expect(members).not.toContain('image_error');
    expect(members).not.toContain('hook_stopped');
  });
});

describe('B-01 ContinueReason is a closed union (no ghost members)', () => {
  const members = parseUnionMembers(typesSrc, 'ContinueReason');

  test('union is non-empty and parsed', () => {
    expect(members.length).toBeGreaterThan(2);
  });

  test('every ContinueReason member has a producer site in src/agent', () => {
    const ghosts = members.filter((m) => !producerSrc.includes(`'${m}'`));
    expect(ghosts).toEqual([]);
  });

  test('removed ghosts are absent from the union', () => {
    expect(members).not.toContain('collapse_drain_retry');
    expect(members).not.toContain('max_output_tokens_escalate');
    expect(members).not.toContain('next_turn');
  });
});
