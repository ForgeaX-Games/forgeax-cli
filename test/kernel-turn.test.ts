/** inferKernelTurnError —— kernel turn 失败不被吞成「空响应」的兜底契约
 *  (bug-empty-response-2026-07-13)。
 *
 *  背景:内核只发 `turn.done { reason: "error" }` 而不带 error payload 时,
 *  runKernelTurn 的 error 保持 undefined → hook:turnEnd 无 error → 前端把
 *  消息标成 status:'done' → ForgeCard 渲染 emptyResponse 占位,失败被吞。
 *  本函数在 reason=error 且无显式 error 时合成可读错误字符串。锁三个行为:
 *    (a) 已有显式 error → 原样保留,不覆盖
 *    (b) reason=error 且无 error → 合成(带/不带 model 两种拼法)
 *    (c) stop / cancelled / undefined 等非-error reason → 不合成
 */

import { describe, expect, test } from 'bun:test';
import { inferKernelTurnError } from '../src/core/kernel-turn';

describe('inferKernelTurnError', () => {
  test('保留显式 error,不被合成文案覆盖', () => {
    expect(inferKernelTurnError('error', 'rate_limit: 429 too many requests', 'claude-fable-5')).toBe(
      'rate_limit: 429 too many requests',
    );
    // 显式 error 优先级最高:即便 reason 不是 error 也原样透传
    expect(inferKernelTurnError('stop', 'boom')).toBe('boom');
  });

  test('reason=error 且无 payload → 合成可读错误', () => {
    expect(inferKernelTurnError('error', undefined, 'claude-fable-5')).toBe(
      'kernel turn ended with reason=error but produced no error payload (model: claude-fable-5)',
    );
    expect(inferKernelTurnError('error', undefined)).toBe(
      'kernel turn ended with reason=error but produced no error payload',
    );
  });

  test('stop / cancelled / max_turns / undefined → 不合成', () => {
    expect(inferKernelTurnError('stop', undefined, 'claude-fable-5')).toBeUndefined();
    expect(inferKernelTurnError('cancelled', undefined)).toBeUndefined();
    expect(inferKernelTurnError('max_turns', undefined)).toBeUndefined();
    expect(inferKernelTurnError(undefined, undefined)).toBeUndefined();
  });
});
