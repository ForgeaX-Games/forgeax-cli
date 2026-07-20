/**
 * H-01 —— rewind boundary 写 WAL 后,两个投影(LLM 历史 foldFromStore / UI transcript
 * walEventsToUiMessages)都识别 `rewind.applied` / `rewind.revoked` append-only 事件:
 * 被回退区间的会话轮次在 fold 时被遮蔽(无 replacement),revoke 后恢复。
 *
 * 这是「回退后 resume 会把回退前后轮次串成一条」的复现单:修复前两个投影都不认 rewind
 * 事件 → 被回退轮次原样复活;修复后两条重建路径共用同一份 mask 逻辑,一致排除。
 *
 * Boundary(test 层):相对 import + Bun。
 */
import { describe, expect, test } from 'bun:test';
import type { CoreEvent } from '../src/events/types';
import { CoreEventType } from '../src/events/events';
import { foldFromStore } from '../src/history/llm-fold-adapter';
import { walEventsToUiMessages } from '../src/tui/transcript/rehydrate';

function userSubmit(prompt: string, turn: number): CoreEvent {
  return { type: CoreEventType.UserPromptSubmit, ts: 0, payload: { prompt, turn } };
}
function assistant(text: string): CoreEvent {
  return { type: 'assistant.message', ts: 0, payload: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function rewindApplied(rewindId: string, keepUserTurns: number): CoreEvent {
  return { type: CoreEventType.RewindApplied, ts: 0, payload: { rewindId, keepUserTurns } };
}
function rewindRevoked(rewindId: string): CoreEvent {
  return { type: CoreEventType.RewindRevoked, ts: 0, payload: { rewindId } };
}
/** ProviderMessage → 纯文本(user 为字符串;assistant 为 content block 数组,取 text 拼接)。 */
function msgText(m: { role: string; content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return JSON.stringify(m.content);
}

/** 一段真实回退流:turn0 → turn1(将被回退)→ rewind(keep turn0)→ turn1-redo。 */
function rewoundStream(): CoreEvent[] {
  return [
    userSubmit('turn0', 0),
    assistant('a0'),
    userSubmit('turn1-old', 1),
    assistant('a1-old'),
    rewindApplied('r1', 1), // 保留第 0 轮 → 遮蔽从第 1 个 user_prompt.submit 起、本事件之前的会话
    userSubmit('turn1-redo', 1),
    assistant('a1-redo'),
  ];
}

describe('H-01 rewind mask — foldFromStore (LLM 历史投影)', () => {
  test('被回退轮次不进 reseed 历史(无 replacement,直接遮蔽)', () => {
    const msgs = foldFromStore(rewoundStream());
    const texts = msgs.map(msgText);
    // 保留:turn0 / a0 / turn1-redo / a1-redo;排除:turn1-old / a1-old。
    expect(texts).toEqual(['turn0', 'a0', 'turn1-redo', 'a1-redo']);
  });

  test('revoke 后被回退轮次恢复(Redo)', () => {
    const evs = [...rewoundStream(), rewindRevoked('r1')];
    const msgs = foldFromStore(evs);
    const texts = msgs.map(msgText);
    expect(texts).toEqual(['turn0', 'a0', 'turn1-old', 'a1-old', 'turn1-redo', 'a1-redo']);
  });
});

describe('H-01 rewind mask — walEventsToUiMessages (UI transcript 投影)', () => {
  test('被回退轮次不进重建 transcript', () => {
    const out = walEventsToUiMessages(rewoundStream());
    const shape = out.map((m) =>
      m.kind === 'user' ? `u:${m.text}` : `a:${((m.event as { message?: CoreEvent }).message?.payload as { content?: Array<{ text?: string }> })?.content?.[0]?.text}`,
    );
    expect(shape).toEqual(['u:turn0', 'a:a0', 'u:turn1-redo', 'a:a1-redo']);
  });

  test('revoke 后 transcript 恢复被回退轮次', () => {
    const out = walEventsToUiMessages([...rewoundStream(), rewindRevoked('r1')]);
    const users = out.filter((m) => m.kind === 'user').map((m) => (m as { text: string }).text);
    expect(users).toEqual(['turn0', 'turn1-old', 'turn1-redo']);
  });
});

// ─── H-03: rewind reseed(fold WAL) 与 resume fold 对同一保留前缀产出一致(含工具轮)──────
function toolTurnStream(): CoreEvent[] {
  return [
    userSubmit('turn0', 0),
    { type: 'assistant.message', ts: 0, payload: { role: 'assistant', content: [{ type: 'text', text: 't' }, { type: 'tool_use', id: 'tu-1', name: 'read_file', input: {} }] } },
    { type: 'tool.result', ts: 0, payload: { toolUseId: 'tu-1', result: 'RES', isError: false } },
    { type: 'assistant.message', ts: 0, payload: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
}

describe('H-03 rewind reseed = resume fold(同保留前缀,含工具轮)', () => {
  test('保留前缀带工具轮:遮蔽 fold(rewind 路径) 与 kept-only fold(resume 路径) 完全一致', () => {
    const kept = toolTurnStream();
    // rewind 路径:kept + 被回退的 turn1 + rewind.applied(保留 turn0)。
    const full = [...kept, userSubmit('turn1-old', 1), assistant('a1-old'), rewindApplied('r1', 1)];
    const viaRewind = foldFromStore(full); // fold WAL 吃遮蔽 == driver rewind reseed
    const viaResume = foldFromStore(kept); // resume 对同一保留前缀
    expect(viaRewind).toEqual(viaResume);
    // 含完整 tool_use/tool_result 对(无孤儿):
    const flat = JSON.stringify(viaRewind);
    expect(flat).toContain('"tool_use"');
    expect(flat).toContain('"tool_result"');
    expect(flat).toContain('"tu-1"');
    expect(flat).toContain('RES');
  });
});

describe('H-01 rewind mask — 两投影对同一保留前缀一致', () => {
  test('foldFromStore 与 walEventsToUiMessages 的 user 轮集合相同', () => {
    const evs = rewoundStream();
    const foldUsers = foldFromStore(evs)
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string);
    const uiUsers = walEventsToUiMessages(evs)
      .filter((m) => m.kind === 'user')
      .map((m) => (m as { text: string }).text);
    expect(foldUsers).toEqual(uiUsers);
  });
});
