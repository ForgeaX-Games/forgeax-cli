/**
 * walEventsToUiMessages —— 纯函数:会话 WAL 的原始事件流(CoreEvent[])→ 可渲染的
 * UiMessage[](供 /resume 把历史会话回灌进当前 transcript)。
 *
 * 这是 reduce.ts 的「上游补片」:live 路径里 driver 把 agent.run 吐的 AgentEvent 直接
 * push 进 session;resume 路径没有 live AgentEvent 流,只有落盘的 CoreEvent WAL。本函数
 * 把 WAL 事件**逆映射**回与 live 同构的 AgentEvent,包成 UiMessage,使 reduceTranscript
 * 渲染出与当时一模一样的 transcript(对齐 cc:恢复 = 用全量 messages 重建 REPL)。
 *
 * 映射(只取有视图意义的 4 类;其余 turn 生命周期 / stop / session / stage 等跳过):
 *   - user_prompt.submit → { kind:'user', text: payload.prompt }
 *   - assistant.message  → { kind:'agent', event:{ type:'assistant', message: <该 CoreEvent> } }
 *   - tool.requested     → { kind:'agent', event:{ type:'tool_call', toolName, toolUseId, input } }
 *   - tool.result        → { kind:'agent', event:{ type:'tool_result', toolUseId, result: <该 CoreEvent> } }
 *
 * 形状对齐:AgentEvent 联合(agent/types.ts)+ events 目录 payload(events.ts)+
 *   history/llm-fold-adapter.ts(同一组事件的 LLM 侧投影)。tool_result 的 `result` 持有
 *   整条 CoreEvent,reduceTranscript 读 `result.payload`(含 isError)判错,与 live 一致。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import,无 react/ink。纯函数,可单测。
 */
import type { CoreEvent } from '../../events/types';
import { computeRewindShadow } from '../../history/rewind-mask';
import type { AgentEvent, UiMessage } from '../contracts';

/** loop 自吐的 assistant 会话事件类型(非 CoreEventType 成员;与 llm-fold-adapter 同源)。 */
const ASSISTANT_MESSAGE = 'assistant.message';
const USER_PROMPT = 'user_prompt.submit';
const TOOL_REQUESTED = 'tool.requested';
const TOOL_RESULT = 'tool.result';

export function walEventsToUiMessages(events: CoreEvent[]): UiMessage[] {
  const out: UiMessage[] = [];
  // H-01:被回退遮蔽的事件不进重建 transcript(与 foldFromStore 共用同一份 mask 逻辑)。
  const shadow = computeRewindShadow(events);
  for (let i = 0; i < events.length; i++) {
    if (shadow[i]) continue;
    const e = events[i];
    switch (e.type) {
      case USER_PROMPT: {
        const p = e.payload as { prompt?: unknown; msgId?: unknown };
        const text = typeof p.prompt === 'string' ? p.prompt : String(p.prompt ?? '');
        // H-02:WAL 携带的回退锚点 msgId 直接还原 → 历史轮文件回退可用。旧 WAL 无 → 走 relinkMsgIds ordinal fallback。
        out.push(typeof p.msgId === 'string' ? { kind: 'user', text, msgId: p.msgId } : { kind: 'user', text });
        break;
      }
      case ASSISTANT_MESSAGE: {
        // message 即该 assistant.message CoreEvent(payload.content),与 live 'assistant' 事件同构。
        out.push({ kind: 'agent', event: { type: 'assistant', message: e } as AgentEvent });
        break;
      }
      case TOOL_REQUESTED: {
        const p = e.payload as { toolName?: string; toolUseId?: string; input?: unknown };
        out.push({
          kind: 'agent',
          event: {
            type: 'tool_call',
            toolName: String(p.toolName ?? ''),
            toolUseId: String(p.toolUseId ?? ''),
            input: p.input,
          },
        });
        break;
      }
      case TOOL_RESULT: {
        const p = e.payload as { toolUseId?: string };
        out.push({
          kind: 'agent',
          event: { type: 'tool_result', toolUseId: String(p.toolUseId ?? ''), result: e } as AgentEvent,
        });
        break;
      }
      // 其余事件(turn.*/stop/session.*/stage/compaction.* 等)无 transcript 视图意义 → 跳过。
      default:
        break;
    }
  }
  return out;
}

/** 回退锚点 id + 是否有代码快照(= CheckpointManager.list() 的子集形状)。 */
export interface CheckpointRef {
  msgId: string;
  hasCode: boolean;
}

/** resume 一致性探针结果(T1)。ok=false 时可直接 console.warn。 */
export interface ResumeConsistency {
  ok: boolean;
  /** 原始 WAL 文本里 user_prompt.submit + assistant.message 记录行数(不经 JSON.parse)。 */
  rawCount: number;
  /** 成功解析出的 user_prompt.submit + assistant.message 事件数(loader 实际拿到的)。 */
  parsedCount: number;
}

/**
 * T1 resume 一致性探针 —— 对比**原始 WAL 文本**里的对话记录行数 vs **成功解析**出的对话事件数。
 *
 * 病理(此类护栏专治):`JsonlFileEventStore.read()` 对坏行/截断行**静默跳过** —— WAL 尾部被
 * 截断(进程崩溃/磁盘满/并发写)会让最后一条 assistant.message 只落了半行,loader 丢弃它,
 * 于是**重放出的历史比盘上真有的少一条**(正是 T1「续接后历史不全」的一个隐蔽变体)。二者
 * 都从「同一份解析后事件」派生就永远相等、探不出;必须拿**不过 parse 的原始行数**作独立基准。
 *
 * 设计对齐 CC 的 resume 一致性校验思路(recorded-on-disk vs reconstructed;非复制其实现)。
 * rawCount 用廉价子串扫(匹配 `"type":"user_prompt.submit"` / `"type":"assistant.message"`,
 * 避免逐行 JSON.parse);对 rewind 遮蔽**免疫**——被遮蔽的行仍是合法 JSON、两侧同样计入。
 * rawCount > parsedCount = 有对话记录行没解析成功(截断/损坏)→ ok=false。纯函数、可单测。
 */
export function checkResumeConsistency(rawJsonl: string, events: CoreEvent[]): ResumeConsistency {
  let rawCount = 0;
  for (const line of rawJsonl.split('\n')) {
    if (!line) continue;
    if (
      line.indexOf(`"type":"${USER_PROMPT}"`) !== -1 ||
      line.indexOf(`"type":"${ASSISTANT_MESSAGE}"`) !== -1
    ) {
      rawCount++;
    }
  }
  let parsedCount = 0;
  for (const e of events) {
    if (e.type === USER_PROMPT || e.type === ASSISTANT_MESSAGE) parsedCount++;
  }
  return { ok: rawCount === parsedCount, rawCount, parsedCount };
}

/**
 * H-02 ordinal fallback —— 给**旧 WAL**(user_prompt.submit 无 msgId 载荷)的历史轮次按序
 * 回填 msgId,使 /resume 后文件回退仍可用。新 WAL 已由 rehydrate 直接还原 msgId,本函数对已
 * 带 msgId 的 user 轮不改(幂等)。
 *
 * fail-soft(不误链):仅当**缺 msgId 的 user 轮数 == checkpoints 条数**时才按序配对回填;
 * 数量不一致(WAL 被截断 / 部分轮无锚点)→ 原样返回(降级纯对话回退),绝不错配。
 * 空 checkpoints 且有缺 msgId 的 user 轮 → 数量不等 → 不动。
 */
export function relinkMsgIds(messages: UiMessage[], checkpoints: CheckpointRef[]): UiMessage[] {
  const missing = messages.filter((m) => m.kind === 'user' && !m.msgId);
  if (missing.length === 0) return messages; // 新 WAL:全带 msgId,无需回填
  if (missing.length !== checkpoints.length) return messages; // 数量不一致 → 保守放弃
  let i = 0;
  return messages.map((m) => {
    if (m.kind === 'user' && !m.msgId) {
      const ref = checkpoints[i++];
      return { ...m, msgId: ref.msgId };
    }
    return m;
  });
}
