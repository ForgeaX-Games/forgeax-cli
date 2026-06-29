/**
 * 编排层(cli)侧的内核接线测试 —— DIP 后 cli **不依赖**任何具体内核实现包。
 *   - llmMessagesToTurnHistory:账本 LLMMessage[] → 中立 TurnMessage[](原生内核消费)。
 *   - resolveKernel:cli 只自带注册 claude-code/codex;forgeax-core 等原生内核需由产品壳
 *     注册进共享 registry —— 未注册时 cli 不感知(回退 claude-code)。
 * 注:forgeax-core 适配器(import @forgeax/forgeax-core)+ 跑一轮的测试已移到 packages/server。
 */
import { test, expect, describe } from 'bun:test';
import { llmMessagesToTurnHistory } from '../src/kernel/llm-history';
import { resolveKernel } from '../src/kernel/resolve-kernel';
import type { LLMMessage } from '../src/llm/types';

describe('llmMessagesToTurnHistory', () => {
  test('maps user/assistant(+toolCalls)/tool, drops system', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'calling' }],
        toolCalls: [{ id: 'c1', name: 'list_games', arguments: { x: 1 } }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'result-text' }], toolCallId: 'c1', toolName: 'list_games', toolStatus: 'completed' },
    ];
    const h = llmMessagesToTurnHistory(msgs);
    expect(h.length).toBe(3); // system dropped
    expect(h[0]).toEqual({ role: 'user', content: 'hello' });
    expect(h[1]).toEqual({ role: 'assistant', content: 'calling', toolCalls: [{ callId: 'c1', name: 'list_games', args: { x: 1 } }] });
    expect(h[2]).toEqual({ role: 'tool', callId: 'c1', ok: true, result: 'result-text' });
  });

  test('failed tool → ok:false', () => {
    const h = llmMessagesToTurnHistory([{ role: 'tool', content: [{ type: 'text', text: 'boom' }], toolCallId: 'c2', toolStatus: 'failed' }]);
    expect(h[0]).toEqual({ role: 'tool', callId: 'c2', ok: false, result: 'boom' });
  });
});

describe('resolveKernel — cli 自带 claude-code/codex;原生内核需外部注册(DIP)', () => {
  test('default → claude-code', () => {
    const saved = process.env.FORGEAX_KERNEL_IMPL;
    try {
      process.env.FORGEAX_KERNEL_IMPL = '';
      expect(resolveKernel('forge').id).toBe('claude-code');
    } finally {
      if (saved == null) delete process.env.FORGEAX_KERNEL_IMPL;
      else process.env.FORGEAX_KERNEL_IMPL = saved;
    }
  });

  test('IMPL=forgeax-core 但未被产品壳注册 → cli 回退 claude-code(不反向依赖原生内核)', () => {
    const saved = process.env.FORGEAX_KERNEL_IMPL;
    try {
      process.env.FORGEAX_KERNEL_IMPL = 'forgeax-core';
      // cli 不注册 forgeax-core;registry 里没有 → resolveKernel 回退 claude-code。
      expect(resolveKernel('forge').id).toBe('claude-code');
    } finally {
      if (saved == null) delete process.env.FORGEAX_KERNEL_IMPL;
      else process.env.FORGEAX_KERNEL_IMPL = saved;
    }
  });
});
