/**
 * remote/approval —— 确认转发纯函数层:格式化(权限/提问 → 手机文本)+ 解析(远端回复 →
 * 结构化决策)+ 分条(chunkReply)。全离线。
 */
import { test, expect, describe } from 'bun:test';
import {
  shortApprovalId,
  formatPermissionPrompt,
  formatQuestionPrompt,
  parseApprovalReply,
  looksLikeApprovalReply,
  decisionLabel,
  chunkReply,
} from '../../src/tui/remote/approval';
import type { PendingPermission, PendingQuestion } from '../../src/tui/contracts';

const PERM: PendingPermission = {
  id: 'perm-3',
  use: { id: 't1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
  perm: { behavior: 'ask', message: 'engine says ask' },
  resolve: () => {},
} as PendingPermission;

const QUESTION: PendingQuestion = {
  id: 'q-2',
  cursor: 0,
  items: [
    {
      question: '选哪个方案?',
      header: '方案',
      options: [{ label: 'A 方案' }, { label: 'B 方案', description: '更稳' }],
      multiSelect: false,
    },
    {
      question: '还要测试吗?',
      header: '测试',
      options: [{ label: '要' }, { label: '不要' }],
      multiSelect: true,
    },
  ],
  selections: [[], []],
  others: [
    { value: '', cursor: 0 },
    { value: '', cursor: 0 },
  ],
};

describe('shortApprovalId', () => {
  test('perm-N → pN;q-N → qN', () => {
    expect(shortApprovalId('perm-3')).toBe('p3');
    expect(shortApprovalId('q-12')).toBe('q12');
  });
});

describe('formatPermissionPrompt', () => {
  test('bash 卡片带命令 + 三种回复说明', () => {
    const s = formatPermissionPrompt(PERM, 'bash');
    expect(s).toContain('p3');
    expect(s).toContain('$ rm -rf /tmp/x');
    expect(s).toContain('y p3');
    expect(s).toContain('a p3');
    expect(s).toContain('n p3');
  });
  test('write_file 卡片带路径', () => {
    const pp = { ...PERM, use: { id: 't2', name: 'Write', input: { file_path: '/tmp/f.txt', content: 'x' } } } as PendingPermission;
    const s = formatPermissionPrompt(pp, 'write_file');
    expect(s).toContain('写入 /tmp/f.txt');
  });
});

describe('formatQuestionPrompt', () => {
  test('单选题:题干 + 编号选项 + 进度 + 回复说明', () => {
    const s = formatQuestionPrompt(QUESTION);
    expect(s).toContain('q2');
    expect(s).toContain('第 1/2 题');
    expect(s).toContain('选哪个方案?');
    expect(s).toContain('1. A 方案');
    expect(s).toContain('2. B 方案 — 更稳');
  });
  test('cursor 推进后渲染第二题(多选)', () => {
    const s = formatQuestionPrompt({ ...QUESTION, cursor: 1 });
    expect(s).toContain('第 2/2 题');
    expect(s).toContain('还要测试吗?');
    expect(s).toContain('多选');
  });
});

describe('parseApprovalReply', () => {
  test('y/a/n + 中英文别名 → 权限决策', () => {
    expect(parseApprovalReply('y p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'allow-once' });
    expect(parseApprovalReply(' YES p3 ')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'allow-once' });
    expect(parseApprovalReply('a p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'allow-always' });
    expect(parseApprovalReply('总是 p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'allow-always' });
    expect(parseApprovalReply('n p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'deny' });
    expect(parseApprovalReply('拒绝 p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'deny' });
    expect(parseApprovalReply('允许 p3')).toEqual({ kind: 'permission', shortId: 'p3', decision: 'allow-once' });
  });
  test('qN + 序号 → 选项(支持多选/逗号)', () => {
    expect(parseApprovalReply('q2 1')).toEqual({ kind: 'question', shortId: 'q2', optionNums: [1] });
    expect(parseApprovalReply('q2 1 3')).toEqual({ kind: 'question', shortId: 'q2', optionNums: [1, 3] });
    expect(parseApprovalReply('q2 1,2')).toEqual({ kind: 'question', shortId: 'q2', optionNums: [1, 2] });
  });
  test('qN + 文本 → 自填', () => {
    expect(parseApprovalReply('q2 用 C 方案,理由是快')).toEqual({
      kind: 'question',
      shortId: 'q2',
      otherText: '用 C 方案,理由是快',
    });
  });
  test('普通聊天不误判', () => {
    expect(parseApprovalReply('帮我看看现在几点')).toBeNull();
    expect(parseApprovalReply('yes 我觉得可以')).toBeNull();
    expect(parseApprovalReply('p3')).toBeNull(); // 光 id 无动词/内容
    expect(looksLikeApprovalReply('帮我改个 bug')).toBe(false);
    expect(looksLikeApprovalReply('y p9')).toBe(true);
  });
});

describe('decisionLabel', () => {
  test('三态标签', () => {
    expect(decisionLabel('allow-once')).toBe('允许一次');
    expect(decisionLabel('allow-always')).toBe('总是允许');
    expect(decisionLabel('deny')).toBe('拒绝');
  });
});

describe('chunkReply', () => {
  test('短文本原样一条', () => {
    expect(chunkReply('hello')).toEqual(['hello']);
  });
  test('长文本按换行断条', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i} ` + 'x'.repeat(50)).join('\n');
    const chunks = chunkReply(text, 1000, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').replace(/\n?…[^]*$/, '').length).toBeLessThanOrEqual(text.length);
    // 每条不超限
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000 + 40); // 尾注余量
  });
  test('超过 maxChunks 截断并加尾注', () => {
    const text = 'y'.repeat(10_000);
    const chunks = chunkReply(text, 1000, 3);
    expect(chunks.length).toBe(3);
    expect(chunks.at(-1)!).toContain('已截断');
  });
});
