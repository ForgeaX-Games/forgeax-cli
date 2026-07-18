/**
 * runKernelTurn —— ConsciousAgent「一轮」的**内核(CC headless)版**。
 *
 * 关键洞见:`ws.ts` 把 `session.eventBus` 的每条事件原样广播,所有 hook→AG-UI
 * 翻译都在 UI 侧。⇒ 只要本函数往 bus 发**与 `runAgentLoop` 同款**的
 * `Hook.StreamLLM` / `Hook.AssistantMessage` / `Hook.ToolCall|ToolResult` 事件,
 * 整条 WS→UI 渲染管线(流式/思考/工具卡/spinner/历史)零改复用。
 *
 * 边界:只读 `composeTurnRequest`(编排层装配 charter+persona+R6 分层记忆+工具)
 * + `resolveKernel` + `runTurn`,再把 KernelEvent 映射成 bus 事件。**不持密钥、
 * 不碰内核内部**。`Hook.TurnStart/TurnEnd` 仍由调用方 `process()` 包。
 *
 * 历史连续性:交给内核会话 —— `threadId = uuidv5(sid::agentPath)`(确定性 UUID,
 * 满足 CC resume 的 UUID 门槛),首轮新建、之后 `--resume` 续接该 agent 的会话;
 * **不**经 ContextWindow 把 ledger 喂模型(ledger 仅供 UI 显示)。
 */
import { createHash } from 'node:crypto';
import { Hook } from '../hooks/types';
import { normalizeContent } from '../message/modality';
import type { EventBusAPI } from './types';
import { composeTurnRequest } from '../kernel/compose-turn-request';
import { resolveKernel } from '../kernel/resolve-kernel';
import { tt } from '../lib/turn-trace';
import { hostTelemetryEnabled } from '../kernel/host-telemetry';
import { startCliKernelTurn, type CliKernelTurnTrace } from '../kernel/cli-kernel-trace';

/** 确定性 UUIDv5(RFC 4122,sha1)——稳定 key → 稳定 UUID(CC resume 要求 UUID)。 */
function uuidv5(name: string): string {
  const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // 标准 DNS 命名空间
  const nsBytes = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `turn.done.reason === 'error'` 但上游没发过显式 error 事件时,合成可读错误——
 *  否则 error 保持 undefined,UI 会把失败渲染成「空响应」占位而非错误卡
 *  (bug-empty-response-2026-07-13)。显式 error / 非-error reason 原样透传。 */
export function inferKernelTurnError(
  reason: string | undefined,
  existingError: string | undefined,
  model?: string,
): string | undefined {
  if (existingError) return existingError;
  if (reason !== 'error') return undefined;
  return `kernel turn ended with reason=error but produced no error payload${model ? ` (model: ${model})` : ''}`;
}

export interface KernelTurnOpts {
  /** = agentPath;既是 compose 的 agentId,也是 threadId key 的一部分。 */
  agentId: string;
  /** session id(threadId 续接 + host-tool 桥定位活 agent)。 */
  sessionId?: string;
  /** 本轮用户输入(合并 events 的 content)。 */
  userText: string;
  /** = this.boundEventBus(emitterId 自动带 agentPath)。 */
  eventBus: EventBusAPI;
  signal: AbortSignal;
  turn: number;
  model?: string;
  callId?: string;
  /** 该 agent 的 host-tools(ToolSpec)→ 经 MCP 桥下发内核(T-A)。 */
  tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  /** 多模态附件(图片);透传进 composeTurnRequest → 原生内核 facade 组 image block。 */
  attachments?: Array<Record<string, unknown>>;
  /** 全链路 trace:浏览器 ui.request 的 W3C traceparent(经 /:sid/messages event payload 传到这);
   *  透传进 composeTurnRequest → TurnRequest.traceparent → 内核把 kernel.turn 挂成其 child。 */
  traceparent?: string;
  /** 本轮回复语言(UI 结算),透传进 composeTurnRequest → dynamicSuffix 指令。 */
  replyLanguage?: 'en' | 'zh';
}

/** 跑一轮内核 turn,把流式/工具/终态映射成 bus 事件。返回 {aborted,error}。 */
export async function runKernelTurn(opts: KernelTurnOpts): Promise<{ aborted: boolean; error?: string }> {
  const { agentId, eventBus, signal, turn } = opts;
  const threadId = uuidv5(`${opts.sessionId ?? 'nosid'}::${agentId}`);

  let finalText = '';
  let thinkingText = '';
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let error: string | undefined;
  let reason: string | undefined; // turn.done.reason(全链路 trace:kernel.turn 结束原因)
  let cliTrace: CliKernelTurnTrace | null = null; // 第 2 层:非-forgeax-core 内核的 kernel.turn span
  const toolName = new Map<string, string>(); // callId → name(供 tool.result 命名)

  try {
    const req = await composeTurnRequest({
      message: opts.userText,
      agentId,
      threadId,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.callId ? { callId: opts.callId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.tools ? { extraTools: opts.tools } : {}),
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}),
      ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
      ...(opts.replyLanguage ? { replyLanguage: opts.replyLanguage } : {}),
    });
    const kernel = resolveKernel(agentId);

    // 第 2 层全链路 trace:非-forgeax-core 内核(codebuddy/claude-code/codex/cursor)跑在本进程、
    //   自身不出 span。给它包一个 kernel.turn(挂浏览器 ui.request 下):provisional 立即落盘,
    //   卡住 → trace 里留「永不收口的 kernel.turn」可定位。forgeax-core 不包(它自 sidecar 出,
    //   重复)。未接 host-telemetry(纯 cli)→ 静默不产。
    if (kernel.id !== 'forgeax-core' && hostTelemetryEnabled()) {
      cliTrace = startCliKernelTurn({
        kernelId: kernel.id,
        agentId,
        ...(opts.sessionId ? { sid: opts.sessionId } : {}),
        ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
      });
    }

    tt('kt.start', { agent: agentId, turn, sid: opts.sessionId, threadId, tools: req.tools?.length });
    let deltas = 0;
    let lastKind = '';
    for await (const ev of kernel.runTurn(req, signal)) {
      lastKind = ev.kind;
      if (ev.kind === 'message.delta' || ev.kind === 'thinking.delta') {
        deltas++;
        if (deltas === 1) tt('kt.first-delta', { agent: agentId, turn, kind: ev.kind });
      } else {
        const evName = (ev as { name?: string; callId?: string }).name;
        const evCall = (ev as { name?: string; callId?: string }).callId;
        tt('kt.event', { agent: agentId, turn, kind: ev.kind, deltas, ...(evName ? { name: evName } : {}), ...(evCall ? { callId: evCall } : {}) });
      }
      switch (ev.kind) {
        case 'message.delta':
          finalText += ev.text;
          eventBus.hook(Hook.StreamLLM, { chunk: { type: 'text', text: ev.text }, turn });
          break;
        case 'thinking.delta':
          thinkingText += ev.text;
          eventBus.hook(Hook.StreamLLM, { chunk: { type: 'thinking', text: ev.text }, turn });
          break;
        case 'tool.call': {
          toolName.set(ev.callId, ev.name);
          const args = (ev.args ?? {}) as Record<string, unknown>;
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'tool_call', id: ev.callId, name: ev.name, arguments: JSON.stringify(args) },
            turn,
          });
          eventBus.hook(Hook.ToolCall, { name: ev.name, args, toolCall: { id: ev.callId, name: ev.name, arguments: args } });
          break;
        }
        case 'tool.call.delta':
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'tool_call_delta', id: ev.callId, name: ev.name, arguments_delta: ev.argsDelta },
            turn,
          });
          break;
        case 'tool.result':
          // P0(历史归属):把工具结果**内容**也带进 bus → 落 per-agent 账本,让 forgeax
          // 拥有可回放的完整一轮(此前只记 name+durationMs,丢了 result)。kernel-neutral:
          // claude-code / codex / forgeax-core 的 tool.result 都带 {callId,ok,result}。
          eventBus.hook(Hook.ToolResult, {
            name: toolName.get(ev.callId) ?? '',
            callId: ev.callId,
            durationMs: 0,
            ok: ev.ok,
            ...(ev.result !== undefined ? { result: ev.result } : {}),
            ...(ev.ok ? {} : { error: ev.error ?? 'tool failed' }),
          });
          break;
        case 'turn.usage':
          usage = { inputTokens: ev.inputTokens ?? 0, outputTokens: ev.outputTokens ?? 0 };
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(opts.model ? { model: opts.model } : {}) },
            turn,
          });
          break;
        case 'error':
          error = `${ev.error.code}: ${ev.error.message}`;
          break;
        case 'turn.done':
          reason = (ev as { reason?: string }).reason; // kernel.turn 结束原因(stop/max_turns/cancelled…)
          break;
        case 'stored-event':
          break;
        default:
          // x.* 扩展事件(x.subagent.* / x.perception / x.ui.* …):publish 进 session
          // EventBus → ws.ts 原样广播给前端(照 perception:query 的做法;不动 wire
          // ChatEvent 类型,绕开稳定接口区)。UI 侧按需消费(轨迹图/ghost 高亮),
          // 无人订阅时零成本。非 x.* 的未知 kind 维持忽略。
          if (typeof (ev as { kind?: unknown }).kind === 'string' && (ev as { kind: string }).kind.startsWith('x.')) {
            try {
              eventBus.publish(
                {
                  type: (ev as { kind: string }).kind,
                  ts: Date.now(),
                  source: `agent:${agentId}`,
                  payload: ev as unknown as Record<string, unknown>,
                },
                agentId,
              );
            } catch {
              /* 观测通道绝不影响主流程 */
            }
          }
          break;
      }
    }
    tt('kt.loop-exit', { agent: agentId, turn, deltas, lastKind, finalLen: finalText.length, error });
  } catch (err) {
    if (!signal.aborted) error = (err as Error).message;
    tt('kt.catch', { agent: agentId, turn, aborted: signal.aborted, error: (err as Error).message });
  } finally {
    // abort 短路对齐 catch 分支的 !signal.aborted:取消的 turn 即便内核发 reason=error 也不合成错误卡。
    if (!signal.aborted) error = inferKernelTurnError(reason, error, opts.model);
    // 第 2 层:收尾 CLI 内核 kernel.turn span(status/reason/usage/model 落 trace+log)。
    //   即便上面 throw / abort 也保证收口,避免假性「永不收口」误报。
    const doneReason = reason ?? (signal.aborted ? 'cancelled' : error ? 'error' : undefined);
    cliTrace?.end({
      ok: !error,
      ...(doneReason ? { reason: doneReason } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
    });
  }

  // 终态:累计文本作为 assistant 消息发出(落 ledger + 渲染提交)。
  if (finalText.trim() || thinkingText.trim() || error) {
    const llmMessage = {
      role: 'assistant' as const,
      content: normalizeContent(finalText || (error ? `⚠️ ${error}` : '')),
      ...(thinkingText.trim() ? { thinking: thinkingText } : {}),
      ts: Date.now(),
      ...(signal.aborted ? { truncated: true } : {}),
    };
    eventBus.hook(Hook.AssistantMessage, {
      llmMessage,
      turn,
      ...(opts.model ? { model: opts.model } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  tt('kt.return', { agent: agentId, turn, aborted: signal.aborted, error });
  return { aborted: signal.aborted, ...(error ? { error } : {}) };
}
