/**
 * resolveKernel —— UI providerOverride 必须优先于全局 FORGEAX_KERNEL_IMPL。
 *
 * 回归守卫:修复「在 the reference agent CLI 发的消息被当成 forgeax」——
 * 内核路径(/api/cli/chat)此前忽略 UI 的 providerOverride、一律用全局 env 选内核,
 * 导致选了 the reference agent CLI 仍跑 forgeax-core。resolveKernel 现接受显式 impl 且优先。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveKernel } from '../src/kernel/resolve-kernel';
import { KernelUnavailableError } from '../src/kernel/kernel-unavailable';

describe('resolveKernel — providerOverride 优先于全局 env', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.FORGEAX_KERNEL_IMPL;
  });
  afterEach(() => {
    if (prev == null) delete process.env.FORGEAX_KERNEL_IMPL;
    else process.env.FORGEAX_KERNEL_IMPL = prev;
  });

  test('显式 claude-code 命中,即便全局 env=codex(不被顶掉)', () => {
    process.env.FORGEAX_KERNEL_IMPL = 'codex';
    expect(resolveKernel('forge', 'claude-code').id).toBe('claude-code');
  });

  test('显式 codex 命中,即便全局 env=claude-code', () => {
    process.env.FORGEAX_KERNEL_IMPL = 'claude-code';
    expect(resolveKernel('forge', 'codex').id).toBe('codex');
  });

  test('显式 codebuddy 命中(cbc 内核已自注册)', () => {
    process.env.FORGEAX_KERNEL_IMPL = 'claude-code';
    expect(resolveKernel('forge', 'codebuddy').id).toBe('codebuddy');
  });

  test('无显式 → 回落全局 env', () => {
    process.env.FORGEAX_KERNEL_IMPL = 'codex';
    expect(resolveKernel('forge').id).toBe('codex');
    expect(resolveKernel('forge', null).id).toBe('codex');
    expect(resolveKernel('forge', '').id).toBe('codex'); // 空串视作未指定
  });

  test('无显式 + 无 env → 默认 forgeax-core,但未注册时回落 claude-code', () => {
    // 默认内核已切 forgeax-core;但它由产品壳(server)注册,本测试无 server →
    //   forgeax-core 未注册 → resolveKernel 回落 claude-code(getKernel(impl) ?? claude-code)。
    delete process.env.FORGEAX_KERNEL_IMPL;
    expect(resolveKernel('forge').id).toBe('claude-code');
  });

  test('显式但未注册的内核 → loud 抛结构化 KernelUnavailableError(reason=unknown-id)', () => {
    process.env.FORGEAX_KERNEL_IMPL = 'claude-code';
    expect(() => resolveKernel('forge', 'totally-unknown-kernel')).toThrow(KernelUnavailableError);
    try {
      resolveKernel('forge', 'totally-unknown-kernel');
    } catch (e) {
      const err = e as KernelUnavailableError;
      expect(err).toBeInstanceOf(KernelUnavailableError);
      expect(err.kernelId).toBe('totally-unknown-kernel');
      expect(err.reason).toBe('unknown-id');
      // 友好文案带内核 id + 引导改选,不再是裸 `kernel_unavailable: <id>`。
      expect(err.message).toContain('totally-unknown-kernel');
      expect(err.message).toContain('可用');
    }
  });
});
