/**
 * 伪造数据验证「真账本压缩」—— ContextWindow.buildPrompt 对 compact_boundary 的应用。
 *
 * 构造一份账本:OLD_1..OLD_4(边界前)→ compact_boundary{summary, keepCount:1}
 * → RECENT_USER / RECENT_ASST(边界后)。物化后应:
 *   1. 边界前内容被砍(仅保留 keepCount=1 条最近 LLM message);
 *   2. summary 升格成合成 "[Session Summary …]" user 消息顶到最前;
 *   3. 边界后内容原样保留。
 */
import { describe, expect, test } from 'bun:test';
import { ContextWindow, type LedgerReader } from '../src/context-window/context-window';

type Ev = { type: string; ts: number; source?: string; payload?: Record<string, unknown> };

function asstEv(ts: number, text: string): Ev {
  return { type: 'inbound_message', ts, source: 'agent', payload: { llmMessage: { role: 'assistant', content: text, ts } } };
}
function userEv(ts: number, text: string): Ev {
  return { type: 'inbound_message', ts, source: 'user', payload: { llmMessage: { role: 'user', content: text, ts } } };
}

function fakeLedger(events: Ev[]): LedgerReader {
  return {
    readAllEvents: async () => events as never,
    readFromTail: async () => events as never, // 测试:整批返回,truncation 自会定位 boundary
  };
}

describe('真账本压缩 — buildPrompt 应用 compact_boundary(伪造数据)', () => {
  test('边界前砍 + summary 升格 + 边界后保留', async () => {
    const events: Ev[] = [
      userEv(1, 'OLD_USER_1'),
      asstEv(2, 'OLD_ASST_1'),
      userEv(3, 'OLD_USER_2'),
      asstEv(4, 'OLD_ASST_2_KEEP'), // keepCount=1 → 这条(边界前最后一条 LLM msg)应保留
      { type: 'compact_boundary', ts: 5, source: 'system', payload: { summary: 'SUMMARY_XYZ_前文已压缩', keepCount: 1 } },
      userEv(6, 'RECENT_USER'),
      asstEv(7, 'RECENT_ASST'),
    ];
    const cw = new ContextWindow('forge', fakeLedger(events));
    const msgs = await cw.buildPrompt();
    const flat = JSON.stringify(msgs);

    // 2. summary 升格成合成 user 消息
    expect(flat).toContain('[Session Summary');
    expect(flat).toContain('SUMMARY_XYZ_前文已压缩');
    // 3. 边界后内容原样保留
    expect(flat).toContain('RECENT_USER');
    expect(flat).toContain('RECENT_ASST');
    // 1. 边界前更早内容被砍(OLD_USER_1 / OLD_ASST_1 / OLD_USER_2 不应出现)
    expect(flat).not.toContain('OLD_USER_1');
    expect(flat).not.toContain('OLD_ASST_1');
    expect(flat).not.toContain('OLD_USER_2');
    // keepCount=1 → 边界前最后一条 LLM message 保留
    expect(flat).toContain('OLD_ASST_2_KEEP');

    // 顺序:summary 在最前,RECENT 在其后
    const iSummary = flat.indexOf('SUMMARY_XYZ');
    const iRecent = flat.indexOf('RECENT_USER');
    expect(iSummary).toBeGreaterThanOrEqual(0);
    expect(iSummary).toBeLessThan(iRecent);
  });

  test('无 compact_boundary → 不压缩,全量保留', async () => {
    const events: Ev[] = [userEv(1, 'KEEP_U'), asstEv(2, 'KEEP_A')];
    const cw = new ContextWindow('forge', fakeLedger(events));
    const flat = JSON.stringify(await cw.buildPrompt());
    expect(flat).toContain('KEEP_U');
    expect(flat).toContain('KEEP_A');
    expect(flat).not.toContain('[Session Summary');
  });
});
