/**
 * toWireEvents — 中立 `KernelEvent` → 现有 wire `ChatEvent`(UI 已消费的形状)。
 *
 * 前端按 SSE `event` 名(= ChatEvent.type)消费,所以内核换实现对 UI 透明。
 * `turn.usage` 折进随后的 `done.usage`(wire 没有独立 usage 事件)。
 * `x.*` 扩展事件 wire 无对应 → 丢弃。
 *
 * `default: never` 穷尽守卫:KernelEvent 新增 kind 而不在此更新 → 编译失败(anti-drift)。
 */
import type { KernelEvent, TurnDoneReason } from '@forgeax/agent-runtime';
import type { ChatEvent } from '../cli-providers/types';

export interface WireFoldState {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  cost?: number;
  durationMs?: number;
}

export function newWireFoldState(): WireFoldState {
  return {};
}

export function toWireEvents(ev: KernelEvent, st: WireFoldState): ChatEvent[] {
  switch (ev.kind) {
    case 'message.delta':
      return [{ type: 'token', text: ev.text }];
    case 'thinking.delta':
      return [{ type: 'thinking', text: ev.text }];
    case 'tool.call':
      return [{ type: 'tool-call', callId: ev.callId, name: ev.name, args: ev.args }];
    case 'tool.call.delta':
      return [{ type: 'tool-call-delta', callId: ev.callId, name: ev.name, argumentsDelta: ev.argsDelta }];
    case 'tool.result':
      return [{ type: 'tool-result', callId: ev.callId, ok: ev.ok, result: ev.result, error: ev.error }];
    case 'turn.usage':
      // 折叠,等 done 时一并带出
      st.usage = {
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheReadTokens: ev.cacheRead,
        cacheCreationTokens: ev.cacheCreation,
      };
      st.cost = ev.costUsd;
      st.durationMs = ev.durationMs;
      return [];
    case 'turn.done':
      return [{
        type: 'done',
        stopReason: kernelStopToWire(ev.reason),
        ...(st.cost != null ? { cost: st.cost } : {}),
        ...(st.durationMs != null ? { durationMs: st.durationMs } : {}),
        ...(st.usage ? { usage: st.usage } : {}),
      }];
    case 'error':
      return [{ type: 'error', message: ev.error.message, code: ev.error.code }];
    case 'stored-event':
      return [{ type: 'stored-event', storedEvent: ev.payload }];
    // 编排注入的扩展,wire 无对应 → 丢弃
    case 'x.delegation':
    case 'x.file_activity':
    case 'x.perception':
    case 'x.subagent.start':
    case 'x.subagent.turn':
    case 'x.subagent.tool':
    case 'x.subagent.done':
      return [];
    // 可观测性事件(压缩边界 / API 重试),wire ChatEvent 无对应 → 丢弃
    case 'compact_boundary':
    case 'api_retry':
      return [];
    default: {
      const _never: never = ev;
      return _never;
    }
  }
}

function kernelStopToWire(r: TurnDoneReason): 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' {
  switch (r) {
    case 'stop': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'max_tokens':
    case 'max_turns': return 'max_tokens';
    case 'cancelled': return 'cancelled';
    case 'error': return 'cancelled';
  }
}
