/** C2 —— LLM 上下文回退(管线级,确定性版)。
 *  验证 ContextWindow.buildPrompt:同一份 ledger,append rewind_boundary 前后,
 *  发给 LLM 的 history 是否精确排除被回退区间。 */

import { describe, expect, test } from "bun:test";
import { ContextWindow, type LedgerReader } from "../src/context-window/context-window";
import type { StoredEvent } from "../src/ledger/types";

function stubLedger(events: StoredEvent[]): LedgerReader {
  return {
    readAllEvents: async () => events,
    readFromTail: async (_isEnough) => events, // 单分片场景:全量给够
  };
}

function ui(ts: number, msgId: string, content: string): StoredEvent {
  return { type: "user_input", ts, source: "user", payload: { content, msgId } };
}
function asst(ts: number, text: string): StoredEvent {
  return {
    type: "hook:assistantMessage", ts, source: "agent",
    payload: { llmMessage: { role: "assistant", content: text } },
  };
}

describe("rewind 后 LLM 上下文", () => {
  const base: StoredEvent[] = [
    ui(100, "m1", "做一个跳台游戏"),
    asst(110, "好的,跳台游戏已创建"),
    ui(200, "m2", "把主角改成红色"),
    asst(210, "主角已改成红色"),
  ];

  test("无 boundary:全量历史可见(基线)", async () => {
    const cw = new ContextWindow("forge", stubLedger(base));
    const flat = JSON.stringify(await cw.buildPrompt());
    expect(flat).toContain("跳台游戏");
    expect(flat).toContain("红色");
  });

  test("回退到 m2 后:被回退 turn 对 LLM 不可见,之前历史保留", async () => {
    const events: StoredEvent[] = [
      ...base,
      { type: "rewind_boundary", ts: 300, source: "system",
        payload: { boundaryId: "b1", targetMsgId: "m2", targetTs: 200, mode: "both" } },
    ];
    const cw = new ContextWindow("forge", stubLedger(events));
    const flat = JSON.stringify(await cw.buildPrompt());
    expect(flat).toContain("跳台游戏");      // m1 turn 保留
    expect(flat).not.toContain("红色");      // m2 turn 整体不可见
  });

  test("恢复(cancel)后:历史重新完整可见", async () => {
    const events: StoredEvent[] = [
      ...base,
      { type: "rewind_boundary", ts: 300, source: "system",
        payload: { boundaryId: "b1", targetMsgId: "m2", targetTs: 200, mode: "both" } },
      { type: "rewind_cancel", ts: 310, source: "system", payload: { boundaryId: "b1" } },
    ];
    const cw = new ContextWindow("forge", stubLedger(events));
    const flat = JSON.stringify(await cw.buildPrompt());
    expect(flat).toContain("红色");
  });

  test("定格后新对话:boundary 仍生效,新消息可见", async () => {
    const events: StoredEvent[] = [
      ...base,
      { type: "rewind_boundary", ts: 300, source: "system",
        payload: { boundaryId: "b1", targetMsgId: "m2", targetTs: 200, mode: "both" } },
      ui(400, "m3", "把主角改成蓝色"),
      asst(410, "主角已改成蓝色"),
    ];
    const cw = new ContextWindow("forge", stubLedger(events));
    const flat = JSON.stringify(await cw.buildPrompt());
    expect(flat).toContain("跳台游戏");
    expect(flat).not.toContain("红色");
    expect(flat).toContain("蓝色");
  });
});
