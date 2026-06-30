/**
 * codex-appserver — `codex app-server`(JSON-RPC)路径专属的 codex-isms 归口。
 *
 * codex 有两条执行面:
 *  - `codex exec --json`(headless 一次性,**无审批回调**)—— codex-profile/codex-mapper,
 *    是 CodexKernel 的 fallback。
 *  - `codex app-server`(持久 JSON-RPC,**有审批 server-request 通道**)—— 本文件 +
 *    codex-appserver-client.ts,是 CodexKernel 的 PRIMARY,把审批接到中立
 *    `TurnRequest.requestPermission`(= Studio 审批卡)。
 *
 * 本文件锁住 app-server 的全部 codex-isms:notification → KernelEvent 映射、审批
 * server-request 的方法名/版本差异(v1 ReviewDecision vs v2 accept/decline)。
 * 脊梁 codex-kernel 只编排 client 生命周期(start/thread/turn/cancel)。
 *
 * 从 server 旧 cli-provider providers/codex.ts 的 app-server 路径移植,改产中立
 * KernelEvent(原产 ChatEvent)。
 */
import type { KernelEvent } from '@forgeax/agent-runtime';

/** app-server 起不来时抛出 → CodexKernel 回退到 exec 路径(在 yield 任何事件前抛)。 */
export class AppServerUnavailable extends Error {}

/** push/pull 异步队列:把 app-server client 的回调桥到 runTurn 的 async-generator 消费者。 */
export class KernelEventQueue {
  private items: KernelEvent[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  push(ev: KernelEvent): void {
    this.items.push(ev);
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  end(): void {
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<KernelEvent> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((res) => { this.waiter = res; });
    }
  }
}

export interface CodexNotifState {
  /** itemId → 累积的命令输出(outputDelta 拼,completed 时落 tool.result)。 */
  outputByItem: Map<string, string>;
  lastUsage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number };
  /** 是否已 push 过终态(turn/completed | error),供脊梁兜底判断。 */
  ended: boolean;
}

export function createCodexNotifState(): CodexNotifState {
  return { outputByItem: new Map(), lastUsage: undefined, ended: false };
}

function usageEvent(state: CodexNotifState): KernelEvent {
  const u = state.lastUsage;
  return {
    kind: 'turn.usage',
    ...(typeof u?.inputTokens === 'number' ? { inputTokens: u.inputTokens } : {}),
    ...(typeof u?.outputTokens === 'number' ? { outputTokens: u.outputTokens } : {}),
    ...(typeof u?.cacheRead === 'number' ? { cacheRead: u.cacheRead } : {}),
  };
}

/** 把一条 app-server notification 映射成 0..N KernelEvent 推进队列。终态(turn/completed
 *  或 error)会 push `turn.usage` + `turn.done|error` 并 `queue.end()`。 */
export function mapCodexNotification(
  method: string,
  params: any,
  state: CodexNotifState,
  queue: KernelEventQueue,
): void {
  switch (method) {
    case 'item/agentMessage/delta':
      if (typeof params?.delta === 'string' && params.delta) {
        queue.push({ kind: 'message.delta', role: 'assistant', text: params.delta });
      }
      return;
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      if (typeof params?.delta === 'string' && params.delta) {
        queue.push({ kind: 'thinking.delta', text: params.delta });
      }
      return;
    case 'item/commandExecution/outputDelta': {
      const id = params?.itemId;
      const chunk = typeof params?.delta === 'string' ? params.delta : (typeof params?.chunk === 'string' ? params.chunk : '');
      if (id && chunk) state.outputByItem.set(id, (state.outputByItem.get(id) ?? '') + chunk);
      return;
    }
    case 'item/started': {
      const it = params?.item;
      if (!it?.id) return;
      if (it.type === 'commandExecution') {
        queue.push({ kind: 'tool.call', callId: it.id, name: 'Bash', args: { command: it.command, cwd: it.cwd } });
      } else if (it.type === 'fileChange') {
        queue.push({ kind: 'tool.call', callId: it.id, name: 'Edit', args: { changes: it.changes ?? it.fileChanges ?? null } });
      } else if (it.type === 'mcpToolCall') {
        queue.push({ kind: 'tool.call', callId: it.id, name: it.tool ?? it.name ?? 'mcp', args: it.arguments ?? {} });
      }
      return;
    }
    case 'item/completed': {
      const it = params?.item;
      if (!it?.id) return;
      if (it.type === 'commandExecution' || it.type === 'fileChange' || it.type === 'mcpToolCall') {
        const ok = it.status === 'completed' || it.status === 'succeeded';
        const out = state.outputByItem.get(it.id) ?? (typeof it.aggregatedOutput === 'string' ? it.aggregatedOutput : '');
        state.outputByItem.delete(it.id);
        queue.push(
          ok
            ? { kind: 'tool.result', callId: it.id, ok: true, result: out }
            : { kind: 'tool.result', callId: it.id, ok: false, error: it.status ? `${it.status}${out ? ': ' + out : ''}` : (out || 'failed') },
        );
      }
      // agentMessage/reasoning 文本已经经 delta 流式 → 忽略。
      return;
    }
    case 'thread/tokenUsage/updated': {
      const t = params?.tokenUsage?.total;
      if (t) state.lastUsage = { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheRead: t.cachedInputTokens };
      return;
    }
    case 'turn/completed':
      queue.push(usageEvent(state));
      queue.push({ kind: 'turn.done', reason: 'stop' });
      state.ended = true;
      queue.end();
      return;
    case 'error':
      queue.push(usageEvent(state));
      queue.push({ kind: 'error', error: { code: 'protocol', message: String(params?.message ?? 'codex error') } });
      queue.push({ kind: 'turn.done', reason: 'error' });
      state.ended = true;
      queue.end();
      return;
    case 'warning':
      if (params?.message) console.warn(`[codex] ${params.message}`);
      return;
    default:
      return; // 容忍未知 notification(实验协议漂移)
  }
}

/** 审批 server-request 的分类 + 版本差异。返回 null = 非审批类(脊梁应报错让 codex 别挂)。 */
export function classifyApproval(method: string): { tool: 'Bash' | 'Edit'; v1: boolean } | null {
  const isExec = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
  const isPatch = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
  if (!isExec && !isPatch) return null;
  // v1 方法用 ReviewDecision(approved/denied);v2 用 accept/decline。
  const v1 = method === 'execCommandApproval' || method === 'applyPatchApproval';
  return { tool: isExec ? 'Bash' : 'Edit', v1 };
}
