/**
 * walEventsToUiMessages —— WAL CoreEvent[] → 可渲染 UiMessage[] 的逆映射单测。
 *
 * 验证 /resume 回灌 transcript 的核心:落盘的 4 类有视图意义事件被映回与 live 同构的
 * AgentEvent(user/assistant/tool_call/tool_result),且能直接喂 reduceTranscript 渲染;
 * 其余生命周期事件(turn/stop/session/stage)被跳过。
 */
import { test, expect, describe } from 'bun:test';
import { walEventsToUiMessages, relinkMsgIds, checkResumeConsistency, type CheckpointRef } from '../../src/tui/transcript/rehydrate';
import { reduceTranscript } from '../../src/tui/transcript/reduce';
import type { SessionEntry, UiMessage } from '../../src/tui/contracts';
import type { CoreEvent } from '../../src/events/types';

/** 造一条 CoreEvent(ts/source 任意,fold/映射只看 type+payload)。 */
const ev = (type: string, payload: unknown): CoreEvent => ({ type, payload, ts: 0 } as CoreEvent);

/** UiMessage[] → SessionEntry[](与 Repl.toSessionLog 同口径)。 */
function toLog(msgs: UiMessage[]): SessionEntry[] {
  return msgs.map((m) =>
    m.kind === 'user' ? { kind: 'user', text: m.text } : { kind: 'event', event: m.event },
  );
}

describe('walEventsToUiMessages', () => {
  test('user_prompt.submit → user 条目', () => {
    const out = walEventsToUiMessages([ev('user_prompt.submit', { prompt: 'hello', turn: 0 })]);
    expect(out).toEqual([{ kind: 'user', text: 'hello' }]);
  });

  // H-02:新 WAL 的 user_prompt.submit 携带 msgId → rehydrate 直接还原(历史轮文件回退可用)。
  test('user_prompt.submit 带 msgId → user 条目还原 msgId', () => {
    const out = walEventsToUiMessages([ev('user_prompt.submit', { prompt: 'hi', turn: 0, msgId: 'abc' })]);
    expect(out).toEqual([{ kind: 'user', text: 'hi', msgId: 'abc' }]);
  });

  test('assistant.message → assistant 事件(message 持原 CoreEvent,payload.content 可读)', () => {
    const a = ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] });
    const out = walEventsToUiMessages([a]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('agent');
    const m = out[0] as Extract<UiMessage, { kind: 'agent' }>;
    expect(m.event.type).toBe('assistant');
    // message 即原事件 → reduce/渲染读 message.payload.content
    expect((m.event as { message: CoreEvent }).message.payload).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    });
  });

  test('tool.requested → tool_call(toolName/toolUseId/input)', () => {
    const out = walEventsToUiMessages([
      ev('tool.requested', { toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } }),
    ]);
    expect(out[0]).toEqual({
      kind: 'agent',
      event: { type: 'tool_call', toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } },
    });
  });

  test('tool.result → tool_result(result 持原 CoreEvent,payload.isError 判错)', () => {
    const r = ev('tool.result', { toolUseId: 'tu1', toolName: 'bash', result: 'ok', isError: false });
    const out = walEventsToUiMessages([r]);
    const m = out[0] as Extract<UiMessage, { kind: 'agent' }>;
    expect(m.event.type).toBe('tool_result');
    expect((m.event as { toolUseId: string }).toolUseId).toBe('tu1');
    expect((m.event as { result: CoreEvent }).result.payload).toMatchObject({ isError: false });
  });

  test('生命周期/噪声事件被跳过', () => {
    const out = walEventsToUiMessages([
      ev('session.start', { sessionId: 's' }),
      ev('turn.start', { turn: 0 }),
      ev('user_prompt.submit', { prompt: 'q', turn: 0 }),
      ev('stage', { stage: 'x', turn: 0 }),
      ev('turn.end', { turn: 0 }),
      ev('stop', { turn: 0 }),
      ev('session.end', {}),
    ]);
    expect(out).toEqual([{ kind: 'user', text: 'q' }]);
  });

  test('端到端:WAL → UiMessage → reduceTranscript 配出工具卡 + 文本轮', () => {
    const events: CoreEvent[] = [
      ev('user_prompt.submit', { prompt: 'run ls', turn: 0 }),
      ev('tool.requested', { toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } }),
      ev('tool.result', { toolUseId: 'tu1', toolName: 'bash', result: 'a.ts', isError: false }),
      ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
    ];
    const items = reduceTranscript(toLog(walEventsToUiMessages(events)));
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'assistant']);
    const tool = items.find((i) => i.kind === 'tool') as Extract<(typeof items)[number], { kind: 'tool' }>;
    expect(tool.status).toBe('ok'); // tool_result 配对成功 → ok
    expect(tool.name).toBe('bash');
  });

  test('空事件流 → 空', () => {
    expect(walEventsToUiMessages([])).toEqual([]);
  });
});

// ─── H-02: relinkMsgIds(旧 WAL ordinal fallback,fail-soft)─────────────────────
describe('relinkMsgIds', () => {
  const cp = (msgId: string, hasCode = true): CheckpointRef => ({ msgId, hasCode });

  test('成对:缺 msgId 的 user 轮数 == checkpoints 条数 → 按序回填', () => {
    const msgs: UiMessage[] = [
      { kind: 'user', text: 'q1' },
      { kind: 'agent', event: { type: 'assistant', message: ev('assistant.message', { content: [] }) } as never },
      { kind: 'user', text: 'q2' },
    ];
    const out = relinkMsgIds(msgs, [cp('m1'), cp('m2')]);
    expect(out.filter((m) => m.kind === 'user').map((m) => (m as { msgId?: string }).msgId)).toEqual(['m1', 'm2']);
  });

  test('错位:数量不一致 → 原样返回(不误链)', () => {
    const msgs: UiMessage[] = [
      { kind: 'user', text: 'q1' },
      { kind: 'user', text: 'q2' },
    ];
    const out = relinkMsgIds(msgs, [cp('m1')]); // 2 user 轮 vs 1 checkpoint
    expect(out).toEqual(msgs); // 不动
    expect(out.every((m) => m.kind !== 'user' || !(m as { msgId?: string }).msgId)).toBe(true);
  });

  test('空索引:有缺 msgId 的 user 轮但无 checkpoints → 原样返回', () => {
    const msgs: UiMessage[] = [{ kind: 'user', text: 'q1' }];
    expect(relinkMsgIds(msgs, [])).toEqual(msgs);
  });

  test('幂等:已带 msgId(新 WAL)→ 不改', () => {
    const msgs: UiMessage[] = [{ kind: 'user', text: 'q1', msgId: 'already' }];
    expect(relinkMsgIds(msgs, [cp('other')])).toEqual(msgs);
  });
});

// ─── T1: checkResumeConsistency(raw 盘上行数 vs 解析事件数 —— 截断/损坏 WAL 时 ok=false)──
describe('checkResumeConsistency', () => {
  /** 把事件序列化成 JSONL(与 JsonlFileEventStore 同格式:每行一个 JSON,type 在首)。 */
  const toJsonl = (evs: CoreEvent[]): string => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const conv: CoreEvent[] = [
    ev('session.start', { sessionId: 's' }),
    ev('user_prompt.submit', { prompt: 'q1', turn: 0 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }),
    ev('user_prompt.submit', { prompt: 'q2', turn: 1 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'a2' }] }),
  ];

  test('健康 WAL:盘上对话行数 == 解析事件数 → ok', () => {
    const r = checkResumeConsistency(toJsonl(conv), conv);
    expect(r).toEqual({ ok: true, rawCount: 4, parsedCount: 4 });
  });

  test('截断:盘上多一条 assistant 行、loader 丢了它 → ok=false(护栏触发)', () => {
    // 原始文本含全部 4 条对话行,但传入的解析事件缺最后一条 assistant(模拟坏行被静默跳过)。
    const raw = toJsonl(conv);
    const parsedMissingLast = conv.slice(0, conv.length - 1); // 丢掉尾部 assistant.message
    const r = checkResumeConsistency(raw, parsedMissingLast);
    expect(r.ok).toBe(false);
    expect(r.rawCount).toBe(4);
    expect(r.parsedCount).toBe(3);
  });

  test('真截断(尾行被砍半):type 首字段仍在 → raw 计入、parse 丢弃 → ok=false', () => {
    // 完整 4 行 + 一条被截断的 assistant.message(只落半行,含 "type":"assistant.message" 但 JSON 不闭合)。
    const raw = toJsonl(conv) + '{"type":"assistant.message","payload":{"content":[{"typ';
    // loader 侧只成功解析出前 4 条对话事件(截断行 JSON.parse 失败被跳过)。
    const r = checkResumeConsistency(raw, conv);
    expect(r.ok).toBe(false);
    expect(r.rawCount).toBe(5); // 4 完整 + 1 截断行(子串命中)
    expect(r.parsedCount).toBe(4);
  });

  test('rewind 遮蔽免疫:被遮蔽行仍是合法 JSON、两侧同计 → ok', () => {
    const withRewind: CoreEvent[] = [
      ...conv,
      ev('rewind.applied', { rewindId: 'r1', keepUserTurns: 1 }),
    ];
    const r = checkResumeConsistency(toJsonl(withRewind), withRewind);
    expect(r.ok).toBe(true); // 遮蔽不影响 raw/parsed 计数(都含被遮蔽行)
  });

  test('空 WAL → ok(0 == 0)', () => {
    expect(checkResumeConsistency('', [])).toEqual({ ok: true, rawCount: 0, parsedCount: 0 });
  });
});
