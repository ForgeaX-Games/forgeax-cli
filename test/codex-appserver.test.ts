/**
 * codex-appserver 单测 —— 验证 `codex app-server` notification → 中立 KernelEvent
 * 的映射、审批 server-request 分类、push/pull 队列。app-server 子进程本身无法在 CI
 * 跑(需 codex 二进制),故锁住可纯函数验证的映射/分类/队列逻辑。
 */
import { describe, expect, test } from 'bun:test';
import {
  KernelEventQueue,
  classifyApproval,
  createCodexNotifState,
  mapCodexNotification,
} from '../src/kernel/codex-appserver';

function drain(fn: (q: KernelEventQueue) => void) {
  const q = new KernelEventQueue();
  fn(q);
  q.end();
  return q;
}

async function collect(q: KernelEventQueue) {
  const out = [];
  for await (const ev of q) out.push(ev);
  return out;
}

describe('codex-appserver mapNotification', () => {
  test('agentMessage delta → message.delta', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('item/agentMessage/delta', { delta: 'hi' }, st, q));
    expect(await collect(q)).toEqual([{ kind: 'message.delta', role: 'assistant', text: 'hi' }]);
  });

  test('reasoning textDelta → thinking.delta', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('item/reasoning/textDelta', { delta: 'think' }, st, q));
    expect(await collect(q)).toEqual([{ kind: 'thinking.delta', text: 'think' }]);
  });

  test('commandExecution started → tool.call Bash; outputDelta + completed → tool.result', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'i1', type: 'commandExecution', command: 'ls', cwd: '/w' } }, st, q);
    mapCodexNotification('item/commandExecution/outputDelta', { itemId: 'i1', delta: 'a.txt\n' }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'i1', type: 'commandExecution', status: 'completed' } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0]).toEqual({ kind: 'tool.call', callId: 'i1', name: 'Bash', args: { command: 'ls', cwd: '/w' } });
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'i1', ok: true, result: 'a.txt\n' });
  });

  test('fileChange completed failed → tool.result not ok', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'f1', type: 'fileChange', changes: [] } }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'f1', type: 'fileChange', status: 'failed' } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0].kind).toBe('tool.call');
    expect((out[0] as any).name).toBe('Edit');
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'f1', ok: false, error: 'failed' });
  });

  test('tokenUsage then turn/completed → turn.usage(with tokens) before turn.done(stop)', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 7, outputTokens: 9, cachedInputTokens: 2 } } }, st, q);
    mapCodexNotification('turn/completed', {}, st, q);
    const out = await collect(q); // turn/completed calls q.end()
    expect(out[0]).toEqual({ kind: 'turn.usage', inputTokens: 7, outputTokens: 9, cacheRead: 2 });
    expect(out[1]).toEqual({ kind: 'turn.done', reason: 'stop' });
    expect(st.ended).toBe(true);
  });

  test('error notification → turn.usage, error, turn.done(error)', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('error', { message: 'boom' }, st, q);
    const out = await collect(q);
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect((out[1] as any).error.message).toBe('boom');
    expect((out[2] as any).reason).toBe('error');
  });

  test('unknown notification tolerated (no events)', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('some/experimental/event', { x: 1 }, st, q));
    expect(await collect(q)).toEqual([]);
  });
});

describe('codex-appserver classifyApproval', () => {
  test('v2 exec approval', () => {
    expect(classifyApproval('item/commandExecution/requestApproval')).toEqual({ tool: 'Bash', v1: false });
  });
  test('v1 exec approval', () => {
    expect(classifyApproval('execCommandApproval')).toEqual({ tool: 'Bash', v1: true });
  });
  test('v2 patch approval', () => {
    expect(classifyApproval('item/fileChange/requestApproval')).toEqual({ tool: 'Edit', v1: false });
  });
  test('v1 patch approval', () => {
    expect(classifyApproval('applyPatchApproval')).toEqual({ tool: 'Edit', v1: true });
  });
  test('non-approval → null', () => {
    expect(classifyApproval('item/started')).toBeNull();
  });
});
