// @desc Tests for microCompact's idle-gap + fixed-placeholder design.
//
// Coverage:
//   1. Active gate — when `now - lastUserInputAt < idleGapMs`, history is
//      returned BYTE-IDENTICAL to the input. This protects the prefix cache.
//   2. Idle trigger — once the gap is crossed, every tool_result outside
//      `keepRecentTools` is replaced with the fixed placeholder.
//   3. lastUserInputAt undefined — treated as idle (cold-start safety).
//   4. Idempotence — running microCompact twice produces byte-identical output.
//   5. Protection zone honored — newest N tool_results stay untouched.

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import { microCompact } from "../src/context-window/micro-compaction.js";
import type { LLMMessage } from "../src/llm/types.js";

const PLACEHOLDER = "[Old tool result content cleared]";
const TWENTY_MIN = 20 * 60 * 1000;

function userMsg(text: string, ts: number): LLMMessage {
  return { role: "user", content: [{ type: "text", text }], ts };
}
function asstMsg(text: string, ts: number): LLMMessage {
  return { role: "assistant", content: [{ type: "text", text }], ts };
}
function toolMsg(toolCallId: string, toolName: string, text: string, ts: number): LLMMessage {
  return {
    role: "tool",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    ts,
  };
}

/** Build a synthetic tool-loop history with `nTools` tool_result messages.
 *  Each tool result is padded to ~1KB to mirror real read_file/shell payloads. */
function buildHistory(nTools: number, baseTs: number): LLMMessage[] {
  const msgs: LLMMessage[] = [userMsg("hello", baseTs)];
  const FILLER = "x".repeat(1024);
  for (let i = 0; i < nTools; i++) {
    msgs.push(asstMsg(`call ${i}`, baseTs + i * 1000 + 100));
    msgs.push(toolMsg(`tc${i}`, "read_file", `result-${i}: ${FILLER}`, baseTs + i * 1000 + 200));
  }
  return msgs;
}

describe("microCompact — active gate (cache safety)", () => {
  it("returns history byte-identical when lastUserInputAt is recent", () => {
    const now = Date.now();
    const msgs = buildHistory(30, now - 60_000);

    const out = microCompact(msgs, {
      keepRecentTools: 20,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - 1000,
    });

    strictEqual(out, msgs, "should return same reference (no compaction needed)");
  });

  it("returns history byte-identical when last input is exactly at idleGapMs - 1", () => {
    const now = Date.now();
    const msgs = buildHistory(40, now - 90_000);

    const out = microCompact(msgs, {
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN - 1),
    });
    strictEqual(JSON.stringify(out), JSON.stringify(msgs));
  });
});

describe("microCompact — idle trigger", () => {
  it("compacts old tool_results when gap exceeds idleGapMs", () => {
    const now = Date.now();
    const msgs = buildHistory(30, now - 30 * 60_000);

    const out = microCompact(msgs, {
      keepRecentTools: 5,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 60_000),
    });

    const tools = out.filter(m => m.role === "tool");
    strictEqual(tools.length, 30);

    const compacted = tools.slice(0, -5);
    const kept = tools.slice(-5);

    for (const t of compacted) {
      const text = (t.content as any[])[0].text;
      strictEqual(text, PLACEHOLDER, "old tool_result must be the fixed placeholder");
      strictEqual(t.truncated, true);
    }
    for (let i = 0; i < kept.length; i++) {
      const text = (kept[i].content as any[])[0].text;
      ok(text.startsWith("result-") && text.includes("xxx"), `recent tool_result #${i} should be untouched`);
    }
  });

  it("treats undefined lastUserInputAt as idle (cold-start)", () => {
    const msgs = buildHistory(8, Date.now() - 60 * 60_000);
    const out = microCompact(msgs, {
      keepRecentTools: 3,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: undefined,
    });
    const compactedCount = out.filter(
      m => m.role === "tool" && (m.content as any[])[0].text === PLACEHOLDER,
    ).length;
    strictEqual(compactedCount, 5);
  });

  it("preserves message structure: role / toolCallId / toolName intact", () => {
    const now = Date.now();
    const msgs = buildHistory(10, now - 60 * 60_000);
    const out = microCompact(msgs, {
      keepRecentTools: 2,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 1000),
    });

    const compacted = out.filter(m => m.role === "tool" && m.truncated);
    ok(compacted.length > 0);
    for (const t of compacted) {
      strictEqual(t.role, "tool");
      ok(typeof t.toolCallId === "string" && t.toolCallId.length > 0);
      ok(typeof t.toolName === "string" && t.toolName.length > 0);
      ok(Array.isArray(t.content) && t.content.length === 1);
      strictEqual((t.content as any[])[0].type, "text");
    }
  });

  it("token footprint shrinks (placeholder is shorter than original)", () => {
    const now = Date.now();
    const msgs = buildHistory(20, now - 60 * 60_000);
    const out = microCompact(msgs, {
      keepRecentTools: 2,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 1000),
    });
    const before = JSON.stringify(msgs).length;
    const after = JSON.stringify(out).length;
    ok(after < before, `compacted output must be smaller (got before=${before}, after=${after})`);
  });
});

describe("microCompact — idempotence (byte stability across runs)", () => {
  it("running twice in idle window produces byte-identical output", () => {
    const now = Date.now();
    const lastInput = now - (TWENTY_MIN + 30_000);
    const msgs = buildHistory(15, now - 60 * 60_000);

    const cfg = { keepRecentTools: 5, idleGapMs: TWENTY_MIN, lastUserInputAt: lastInput };
    const once = microCompact(msgs, cfg);
    const twice = microCompact(once, cfg);

    strictEqual(JSON.stringify(once), JSON.stringify(twice));
  });

  it("transition from active → idle is one-shot, then stable", () => {
    const now = Date.now();
    const msgs = buildHistory(12, now - 60 * 60_000);

    const active = microCompact(msgs, {
      keepRecentTools: 3,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - 1000,
    });
    strictEqual(JSON.stringify(active), JSON.stringify(msgs), "active gate keeps bytes");

    const idleOnce = microCompact(msgs, {
      keepRecentTools: 3,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 1000),
    });
    const idleTwice = microCompact(idleOnce, {
      keepRecentTools: 3,
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 1000),
    });
    strictEqual(JSON.stringify(idleOnce), JSON.stringify(idleTwice), "idle path is idempotent");
  });
});

describe("microCompact — defaults", () => {
  it("defaults to keep 20 tools when keepRecentTools omitted", () => {
    const now = Date.now();
    const msgs = buildHistory(25, now - 60 * 60_000);
    const out = microCompact(msgs, {
      idleGapMs: TWENTY_MIN,
      lastUserInputAt: now - (TWENTY_MIN + 1000),
    });
    const tools = out.filter(m => m.role === "tool");
    const placeholder = tools.filter(t => (t.content as any[])[0].text === PLACEHOLDER);
    strictEqual(placeholder.length, 5, "exactly the oldest 5 of 25 should be cleared");
  });
});

describe("microCompact — long-history smoke (cache-stability proxy)", () => {
  it("during active conversation, output is byte-identical to input across 10 turns", () => {
    const now = Date.now();
    const msgs = buildHistory(100, now - 90 * 60_000);
    const baseline = JSON.stringify(msgs);

    let view = msgs;
    for (let turn = 0; turn < 10; turn++) {
      view = microCompact(view, {
        keepRecentTools: 20,
        idleGapMs: TWENTY_MIN,
        lastUserInputAt: now - turn * 60_000,
      });
    }
    strictEqual(JSON.stringify(view), baseline, "active turns must never alter wire bytes");
  });
});
