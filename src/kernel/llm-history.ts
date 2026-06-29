/**
 * llmMessagesToTurnHistory —— 把编排层账本物化出的 `LLMMessage[]`(ContextWindow.buildPrompt)
 * 映射成中立 `TurnMessage[]`,喂原生内核 forgeax-core 的 `TurnRequest.history`(F6)。
 *
 * 仅原生内核消费 history(host-owned 上下文);租用内核(claude-code/codex)忽略,走
 * 自己的会话续接。system 消息丢弃(原生内核自建 charter/persona system)。纯函数,可单测。
 */
import type { TurnMessage } from '@forgeax/agent-runtime';
import type { LLMMessage } from '../llm/types';
import type { ContentPart } from '../core/types';

/** ContentPart[] → 中立内容:全 text → 拼成字符串;含媒体/文件 → 原样块数组。 */
function contentToNeutral(parts: ContentPart[]): string | Array<Record<string, unknown>> {
  if (parts.length > 0 && parts.every((p) => p.type === 'text')) {
    return parts.map((p) => (p as { text: string }).text).join('');
  }
  return parts as unknown as Array<Record<string, unknown>>;
}

export function llmMessagesToTurnHistory(msgs: readonly LLMMessage[]): TurnMessage[] {
  const out: TurnMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue; // 原生内核自建 system,不回灌历史 system
    if (m.role === 'user') {
      out.push({ role: 'user', content: contentToNeutral(m.content) });
    } else if (m.role === 'assistant') {
      out.push(
        m.toolCalls && m.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: contentToNeutral(m.content),
              toolCalls: m.toolCalls.map((tc) => ({ callId: tc.id, name: tc.name, args: tc.arguments })),
            }
          : { role: 'assistant', content: contentToNeutral(m.content) },
      );
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        callId: m.toolCallId ?? '',
        ok: m.toolStatus !== 'failed',
        result: contentToNeutral(m.content),
      });
    }
  }
  return out;
}
