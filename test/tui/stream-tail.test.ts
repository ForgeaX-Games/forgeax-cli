/**
 * stream-tail 纯函数单测 —— 在写流式文本的尾部视口裁剪(clipStreamTail / streamTailBudget)。
 *
 * 覆盖:
 *   - 空文本 / 预算内 → 不裁
 *   - 超预算 → 只保留末尾窗口,clipped=true,且保留部分估行 ≤ 预算
 *   - 单条超预算的末行 → 整行保留(兜底,不可再切)
 *   - 长段落按显示宽度折行计入(raw 行数低估防不住的场景)
 *   - CJK 宽字符按 2 列计宽
 *   - streamTailBudget:预留 + 下限
 *
 * 纯函数测试,不依赖 react/ink。
 */
import { test, expect, describe } from 'bun:test';
import {
  clipStreamTail,
  streamTailBudget,
  STREAM_TAIL_MIN_ROWS,
  STREAM_TAIL_RESERVED_ROWS,
} from '../../src/tui/transcript/stream-tail';

describe('clipStreamTail', () => {
  test('空文本不裁', () => {
    expect(clipStreamTail('', 80, 10)).toEqual({ text: '', clipped: false });
  });

  test('预算内原样返回', () => {
    const text = 'a\nb\nc';
    expect(clipStreamTail(text, 80, 10)).toEqual({ text, clipped: false });
  });

  test('恰好占满预算不裁(边界)', () => {
    const text = ['1', '2', '3'].join('\n');
    expect(clipStreamTail(text, 80, 3)).toEqual({ text, clipped: false });
  });

  test('超预算只留末尾窗口', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const r = clipStreamTail(lines.join('\n'), 80, 5);
    expect(r.clipped).toBe(true);
    expect(r.text).toBe(lines.slice(-5).join('\n'));
  });

  test('长段落按折行计入:raw 行少但视觉行超,仍会裁', () => {
    // 每条 raw 行 200 列宽 → 80 列下折 3 视觉行;4 条 = 12 视觉行 > 预算 5。
    const long = 'x'.repeat(200);
    const r = clipStreamTail([long, long, long, long].join('\n'), 80, 5);
    expect(r.clipped).toBe(true);
    // 保留部分 ≤ 预算:5/3 → 只留 1 条(2 条已 6 行超预算)。
    expect(r.text).toBe(long);
  });

  test('CJK 按 2 列计宽', () => {
    // 40 个全角字 = 80 列 → 80 列下 1 视觉行;若按 .length 算只有 40。
    const cjk = '汉'.repeat(80); // 160 列 → 2 视觉行
    const r = clipStreamTail([cjk, cjk, cjk].join('\n'), 80, 3); // 共 6 行 > 3
    expect(r.clipped).toBe(true);
    expect(r.text).toBe(cjk); // 留 1 条(2 行) ≤ 3
  });

  test('末行独自超预算 → 字符级切尾(无换行长段落也压进预算)', () => {
    const huge = 'y'.repeat(800); // 80 列下 10 视觉行 > 预算 5
    const r = clipStreamTail(`head\n${huge}`, 80, 5);
    expect(r.clipped).toBe(true);
    expect(r.text).toBe('y'.repeat(400)); // 保留末尾 5*80 列
  });

  test('单条超长 CJK 行字符级切尾按 2 列计宽', () => {
    const cjk = '汉'.repeat(400); // 800 列 → 10 视觉行 > 预算 5
    const r = clipStreamTail(cjk, 80, 5);
    expect(r.clipped).toBe(true);
    expect(r.text).toBe('汉'.repeat(200)); // 5*80=400 列 ÷ 2 列/字
  });

  test('空行占 1 行计入', () => {
    const r = clipStreamTail('a\n\n\n\n\nb', 80, 3);
    expect(r.clipped).toBe(true);
    expect(r.text.split('\n').length).toBe(3);
  });
});

describe('streamTailBudget', () => {
  test('终端高 − 预留', () => {
    expect(streamTailBudget(40)).toBe(40 - STREAM_TAIL_RESERVED_ROWS);
  });

  test('极矮终端落到下限', () => {
    expect(streamTailBudget(10)).toBe(STREAM_TAIL_MIN_ROWS);
    expect(streamTailBudget(0)).toBe(STREAM_TAIL_MIN_ROWS);
  });
});
