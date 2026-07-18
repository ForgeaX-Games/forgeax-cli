/**
 * TODO 028 — abort → turn.done{reason:'cancelled'} 收口(R4-05 不变量)。
 *
 * 不变量(R4-05):一轮被 `signal.abort()` 后,内核最后一个事件**必须**是
 * `turn.done{reason:'cancelled'}` —— 不能是 `error`。CC / codex(exec fallback)
 * 形态下「取消 = 杀进程」,杀进程会让退出码非零 / 把读流打断成异常,naïve 实现会
 * 误判为崩溃并发 error。本测试钉住:被取消路径收口 cancelled,真崩溃仍收口 error。
 *
 * ## 测试接缝(test seam)
 * 两个内核的 `runTurn` 都靠 `Bun.spawn` 真起 `claude`/`codex` 子进程,单测里既不
 * 可得也不确定性,无法直接驱动公共 generator。但「取消 vs 崩溃」的判定已被收敛成
 * 两个**纯函数接缝**,内核 spine 只是按 `signal.aborted` 选分支调用它们:
 *   - claude:`flushClaudeMapper(state, 'cancelled')` → `chatEventToKernel(...)`
 *             (与 claude-code-kernel.ts exit 处的 abort 分支**逐字**同构)。
 *   - codex :`flushCodexMapper(state, exit, aborted=true)`
 *             (与 codex-kernel.ts exec fallback 的 flush 调用**逐字**同构)。
 * 故本测试驱动这两条与内核实现共享的纯接缝,断言其产出的事件序列;非零退出但
 * **未** abort 的回归用例同样经接缝断言仍为 error。
 */
import { test, expect, describe } from 'bun:test';
import type { KernelEvent } from '@forgeax/agent-runtime';
import {
  createClaudeMapperState,
  flushClaudeMapper,
} from '../src/cli-providers/shared/claude-code-mapper';
import { chatEventToKernel } from '../src/kernel/cc-profile';
import {
  createCodexMapperState,
  flushCodexMapper,
} from '../src/kernel/codex-mapper';

// ── claude-code:exit 处 abort 分支与本组合逐字同构 ──────────────────────
// claude-code-kernel.ts:
//   if (signal.aborted) for (const ev of flushClaudeMapper(state, 'cancelled')) yield* chatEventToKernel(ev);
function ccAbortTerminal(): KernelEvent[] {
  const state = createClaudeMapperState();
  const out: KernelEvent[] = [];
  for (const ev of flushClaudeMapper(state, 'cancelled')) {
    for (const k of chatEventToKernel(ev)) out.push(k);
  }
  return out;
}

// 非 abort 的非零退出(真崩溃)分支:claude-code-kernel.ts 仍走 error。
function ccErrorTerminal(code: number, tail: string): KernelEvent[] {
  const out: KernelEvent[] = [];
  for (const k of chatEventToKernel({ type: 'error', message: `claude exited ${code}${tail ? ': ' + tail : ''}` })) {
    out.push(k);
  }
  return out;
}

describe('claude-code kernel — abort 收口 turn.done{cancelled}', () => {
  test('被 abort → 最后一个事件是 turn.done{reason:cancelled}(非 error)', () => {
    const evs = ccAbortTerminal();
    const last = evs[evs.length - 1]!;
    expect(last.kind).toBe('turn.done');
    expect((last as Extract<KernelEvent, { kind: 'turn.done' }>).reason).toBe('cancelled');
    // 不得混入 error 帧。
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    // 不变量:turn.usage 仍在 turn.done 之前。
    const usageIdx = evs.findIndex((e) => e.kind === 'turn.usage');
    const doneIdx = evs.findIndex((e) => e.kind === 'turn.done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(doneIdx);
  });

  test('回归:未 abort 的非零退出仍收口 error(turn.done{reason:error})', () => {
    const evs = ccErrorTerminal(1, 'fatal: boom');
    const last = evs[evs.length - 1]!;
    expect(last.kind).toBe('turn.done');
    expect((last as Extract<KernelEvent, { kind: 'turn.done' }>).reason).toBe('error');
    const err = evs.find((e) => e.kind === 'error') as Extract<KernelEvent, { kind: 'error' }> | undefined;
    expect(err).toBeDefined();
    expect(err!.error.message).toContain('claude exited 1');
    expect(err!.error.message).toContain('boom');
  });

  test('flushClaudeMapper 缺省仍是 end_turn(不回归正常完成路径)', () => {
    const state = createClaudeMapperState();
    const evs = flushClaudeMapper(state);
    expect(evs).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });
});

describe('codex kernel(exec fallback)— abort 收口 turn.done{cancelled}', () => {
  test('被 abort(aborted=true)→ 最后一个事件是 turn.done{reason:cancelled}', () => {
    const state = createCodexMapperState();
    // codex-kernel.ts:flushCodexMapper(state, exitInfo, ac.signal.aborted)
    // 杀进程后 exit.code 非零,但 aborted=true 必须压过退出码、收口 cancelled。
    const evs = [...flushCodexMapper(state, { code: 137, stderr: 'killed' }, true)];
    const last = evs[evs.length - 1]!;
    expect(last.kind).toBe('turn.done');
    expect((last as Extract<KernelEvent, { kind: 'turn.done' }>).reason).toBe('cancelled');
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    // 不变量:turn.usage 在 turn.done 之前。
    expect(evs[0].kind).toBe('turn.usage');
    expect(state.doneEmitted).toBe(true);
  });

  test('回归:未 abort 的非零退出仍收口 error(turn.done{reason:error})', () => {
    const state = createCodexMapperState();
    const evs = [...flushCodexMapper(state, { code: 7, stderr: 'line1\nfatal: nope\n' }, false)];
    const last = evs[evs.length - 1]!;
    expect(last.kind).toBe('turn.done');
    expect((last as Extract<KernelEvent, { kind: 'turn.done' }>).reason).toBe('error');
    const err = evs.find((e) => e.kind === 'error') as Extract<KernelEvent, { kind: 'error' }> | undefined;
    expect(err).toBeDefined();
    expect(err!.error.message).toContain('codex exited 7');
    expect(err!.error.message).toContain('fatal: nope');
  });

  test('回归:未 abort 的零退出仍收口 stop(正常完成)', () => {
    const state = createCodexMapperState();
    const evs = [...flushCodexMapper(state, { code: 0, stderr: '' }, false)];
    expect(evs).toEqual([
      { kind: 'turn.usage' },
      { kind: 'turn.done', reason: 'stop' },
    ]);
  });

  test('幂等:已发终态后 flush 不再追加(即便 aborted)', () => {
    const state = createCodexMapperState();
    state.doneEmitted = true;
    expect([...flushCodexMapper(state, { code: 137, stderr: '' }, true)]).toEqual([]);
  });
});
