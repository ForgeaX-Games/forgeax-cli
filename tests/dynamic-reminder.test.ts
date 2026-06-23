// @desc Tests for embedDynamicInLastUserContent (cache-prefix-friendly trailing reminder
// + mid-tool-loop guard that protects assistant-turn / interleaved-thinking
// continuity, with a depth-N heartbeat exception so long loops still get
// occasional state refresh).
//
// Four layers of coverage:
//   1. Unit cases — verify the impl's behavioural contract on synthetic
//      framework-message shapes:
//        - empty input  → reminder-only user msg (cold start);
//        - user tail    → append a fresh trailing user msg;
//        - tool tail (depth < N) → SKIP (don't wedge user text mid-loop);
//        - assistant w/ pending toolCalls → SKIP (same reason);
//        - tool tail at depth = N (heartbeat) → INJECT once;
//        - input is never mutated.
//   2. Wire integration — round-trip the enriched messages through each
//      provider's role mapping (Anthropic / OpenAI Chat-Completions) and
//      assert that, when a reminder IS appended (user-tail case), it lands
//      on the actual LAST wire user-role message, not somewhere in the
//      middle. Tool-tail inputs at sub-heartbeat depth are asserted to
//      round-trip unchanged.
//   3. Cache-prefix stability simulation — run the same conversation twice
//      with different dynamic timestamps, JSON-serialise the resulting wire
//      bodies, and measure byte-level common-prefix length. Compares the new
//      impl against the old (inlined) impl to quantify the regression that
//      was driving Anthropic admin sessions to ~42% cache hit rate. The
//      mid-tool-loop SKIP only makes prefix overlap strictly better than the
//      previous "always append" behaviour, so the existing thresholds still
//      hold (and are in fact more relaxed than reality).

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import {
  embedDynamicInLastUserContent,
} from "../src/llm/provider-utils.js";
import { messagesToOpenAI } from "../src/llm/openai-compat.js";
import { messagesToAnthropic } from "../src/llm/anthropic.js";
import type { LLMMessage, SystemBlock } from "../src/llm/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Old implementation, inlined verbatim from before the fix. Kept here ONLY
// as a benchmark control so we can quantify the cache-prefix improvement.
// Do NOT export — production code path runs the new impl in provider-utils.
// ─────────────────────────────────────────────────────────────────────────
function embedDynamicInLastUserContent_OLD(
  messages: LLMMessage[],
  dynamicBlocks: SystemBlock[],
): LLMMessage[] {
  if (dynamicBlocks.length === 0) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const reminderText =
    `<system-reminder>\n` +
    dynamicBlocks.map((b) => b.text).join("\n\n") +
    `\n</system-reminder>`;
  const result = messages.slice();
  const last = result[lastUserIdx];
  result[lastUserIdx] = {
    ...last,
    content: [...last.content, { type: "text", text: reminderText }],
  };
  return result;
}

// ─── Fixture builders ────────────────────────────────────────────────────

const userMsg = (text: string): LLMMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistantToolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "" }],
  toolCalls: [{ id, name, arguments: args }],
});

const toolResult = (id: string, text: string): LLMMessage => ({
  role: "tool",
  toolCallId: id,
  toolName: "read_file",
  toolStatus: "completed",
  content: [{ type: "text", text }],
});

const STABLE: SystemBlock[] = [
  {
    name: "soul",
    text: "<soul>I am a helpful assistant with a long stable system prompt.</soul>",
    cacheHint: "stable",
    priority: 0,
  },
];

const dynamicAt = (ts: string): SystemBlock[] => [
  {
    name: "agent-status",
    text: `<agent-status>\nCurrent Time: ${ts}\nWorking Directory: /tmp\n</agent-status>`,
    cacheHint: "dynamic",
    priority: 30,
  },
];

// Build a typical tool-loop conversation: one human input followed by N
// rounds of `[assistant_with_tool_use, tool_result]`. The framework's
// most-recent `role: "user"` is the very first message, all subsequent
// turns are `assistant`/`tool` — i.e. the worst case for the old impl.
function buildToolLoop(n: number): LLMMessage[] {
  const msgs: LLMMessage[] = [
    userMsg("帮我查 5 个文件并汇总，每个不超过两行。"),
  ];
  for (let i = 0; i < n; i++) {
    msgs.push(assistantToolCall(`call_${i}`, "read_file", { path: `f${i}.txt` }));
    msgs.push(
      toolResult(
        `call_${i}`,
        `f${i}.txt: lorem ipsum dolor sit amet — line A. lorem ipsum dolor sit amet — line B.`,
      ),
    );
  }
  return msgs;
}

// Same as buildToolLoop but ends with a fresh `role: "user"` follow-up.
// This is the regime where `embedDynamicInLastUserContent` ACTUALLY injects
// a system-reminder (tail is non-tool), so it's the right shape for any
// test that wants to exercise the "with reminder" wire form.
function buildToolLoopThenUser(n: number, followUp = "再帮我跟进一下"): LLMMessage[] {
  return [...buildToolLoop(n), userMsg(followUp)];
}

// ─── Layer 1: unit ───────────────────────────────────────────────────────

describe("embedDynamicInLastUserContent (unit)", () => {
  it("noops when dynamicBlocks is empty (returns same reference)", () => {
    const msgs = [userMsg("hi")];
    strictEqual(embedDynamicInLastUserContent(msgs, []), msgs);
  });

  it("emits a reminder-only user message even when input messages are empty", () => {
    const out = embedDynamicInLastUserContent([], dynamicAt("12:00:00"));
    strictEqual(out.length, 1);
    strictEqual(out[0].role, "user");
    const part = out[0].content[0] as { type: "text"; text: string };
    ok(part.text.includes("<system-reminder>"));
    ok(part.text.includes("12:00:00"));
  });

  it("SKIPS append when tail is a tool result at sub-heartbeat depth", () => {
    // tool_result is the same assistant turn the model started in the
    // previous request — wedging a user text in here breaks the wire
    // protocol the model was trained on (interleaved thinking, GPT-5
    // reasoning chain, Gemini functionResponse continuation). Reminder
    // is deferred to the next non-tool-tail turn (or to the heartbeat
    // boundary, whichever comes first).
    const msgs = buildToolLoop(2); // depth = 2, well below N=8
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));

    strictEqual(out, msgs, "should return the SAME reference (no copy on skip)");
    strictEqual(out.length, msgs.length);
    strictEqual(out[out.length - 1].role, "tool");

    // Original first user message stays untouched — no SR poisoning.
    strictEqual(out[0].content.length, 1);
    const firstUserText = (out[0].content[0] as { text: string }).text;
    ok(!firstUserText.includes("<system-reminder>"));
  });

  it("SKIPS append when tail is an assistant with pending tool_calls", () => {
    // Same rationale: the assistant turn isn't done yet, the framework is
    // about to feed tool results into it. Don't pretend the user spoke.
    // depth = 0 (no completed tool_results yet) → also skip.
    const msgs: LLMMessage[] = [
      userMsg("查 a.txt"),
      assistantToolCall("call_a", "read_file", { path: "a.txt" }),
    ];
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));

    strictEqual(out, msgs, "should return the SAME reference (no copy on skip)");
    strictEqual(out.length, 2);
    strictEqual(out[out.length - 1].role, "assistant");
  });

  it("INJECTS at the heartbeat boundary (tool tail, depth = N=8)", () => {
    // Long-running loops still need state refresh occasionally — once
    // depth crosses a multiple of HEARTBEAT_EVERY_N_TOOL_RESULTS=8 the
    // skip is overridden and exactly one reminder is appended.
    const msgs = buildToolLoop(8); // depth = 8 (exact heartbeat)
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));

    strictEqual(out.length, msgs.length + 1, "expected reminder append");
    strictEqual(out[out.length - 1].role, "user");
    const part = out[out.length - 1].content[0] as { type: "text"; text: string };
    ok(part.text.includes("<system-reminder>"));
    ok(part.text.includes("12:00:00"));
  });

  it("SKIPS at depth = N+1 (between heartbeats)", () => {
    // Right after a heartbeat fires (depth=8) we go back to skipping for
    // the next 7 turns. depth=9 must not trigger another inject.
    const msgs = buildToolLoop(9);
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(out, msgs, "should skip at non-multiple depth");
    strictEqual(out[out.length - 1].role, "tool");
  });

  it("INJECTS again at depth = 2N (next heartbeat)", () => {
    const msgs = buildToolLoop(16); // depth = 16 = 2 * 8
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(out.length, msgs.length + 1);
    strictEqual(out[out.length - 1].role, "user");
    const part = out[out.length - 1].content[0] as { type: "text"; text: string };
    ok(part.text.includes("<system-reminder>"));
  });

  it("SKIPS at depth = N when tail is the assistant's tool_use (no result yet)", () => {
    // Heartbeat counts COMPLETED tool rounds (tail must be a tool_result).
    // If the tail is an assistant tool_use waiting for execution, depth is
    // measured against the prior tool_result span — but this case is the
    // odd one where we have 7 prior tool_results AND a fresh asst tool_use
    // tail. depth(messages) walks back over the asst (skip) and counts 7
    // tool_results → 7, NOT a heartbeat boundary. Confirms we're counting
    // tool_results not raw tail position.
    const msgs: LLMMessage[] = [
      ...buildToolLoop(7), // 7 completed rounds, tail = tool_result
      assistantToolCall("call_8", "read_file", { path: "f8.txt" }), // pending
    ];
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(out, msgs, "depth=7 (under N=8) → still skip");
  });

  it("appends when tail is a 'closed' assistant (no pending tool_calls)", () => {
    // An assistant message without toolCalls represents a finished turn
    // (or a prefill). Either way it's safe to inject a fresh user-role
    // reminder afterwards — there's no live tool protocol to disrupt.
    const msgs: LLMMessage[] = [
      userMsg("hi"),
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(out.length, msgs.length + 1);
    strictEqual(out[out.length - 1].role, "user");
    const part = out[out.length - 1].content[0] as { type: "text"; text: string };
    ok(part.text.includes("<system-reminder>"));
  });

  it("appends a NEW trailing user msg even when tail is already user", () => {
    const msgs = [userMsg("first"), userMsg("second")];
    const out = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(out.length, 3);
    strictEqual(out[2].role, "user");
    // Earlier user messages should NOT have been touched.
    strictEqual(out[0].content.length, 1);
    strictEqual(out[1].content.length, 1);
  });

  it("does not mutate the input messages array (tool tail / skip path)", () => {
    const msgs = buildToolLoop(2);
    const beforeLen = msgs.length;
    const beforeFirstContent = msgs[0].content.length;
    embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(msgs.length, beforeLen);
    strictEqual(msgs[0].content.length, beforeFirstContent);
  });

  it("does not mutate the input messages array (user tail / append path)", () => {
    const msgs = [userMsg("first"), userMsg("second")];
    const beforeLen = msgs.length;
    const beforeLastContent = msgs[msgs.length - 1].content.length;
    embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    strictEqual(msgs.length, beforeLen);
    strictEqual(msgs[msgs.length - 1].content.length, beforeLastContent);
  });
});

// ─── Layer 2: wire integration per provider ──────────────────────────────

describe("embedDynamicInLastUserContent (wire integration)", () => {
  it("Anthropic: reminder ends up as the LAST user-role wire message", async () => {
    const msgs = buildToolLoopThenUser(3);
    const enriched = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    const wire = await messagesToAnthropic(enriched);

    // Anthropic maps role:"tool" → role:"user" (with tool_result blocks).
    // The very last wire entry must be the reminder-only user message.
    const last = wire[wire.length - 1];
    strictEqual(last.role, "user");
    const lastBlocks = last.content as Array<{ type: string; text?: string }>;
    strictEqual(lastBlocks.length, 1);
    strictEqual(lastBlocks[0].type, "text");
    ok(lastBlocks[0].text!.includes("<system-reminder>"));

    // Marker B (placed by annotateMessageCache later) lands on the
    // SECOND-to-last user-role message; that one must NOT contain a
    // <system-reminder> block (otherwise the cache prefix gets the
    // dynamic bytes folded in and the whole point is moot).
    let secondLastUserIdx = -1;
    for (let i = wire.length - 2; i >= 0; i--) {
      if (wire[i].role === "user") {
        secondLastUserIdx = i;
        break;
      }
    }
    ok(secondLastUserIdx >= 0, "expected a second-last user wire message");
    const secondLast = wire[secondLastUserIdx];
    const secondLastBlocks = secondLast.content as Array<{ type: string; text?: string }>;
    for (const b of secondLastBlocks) {
      if (b.type === "text" && b.text) {
        ok(
          !b.text.startsWith("<system-reminder>"),
          "second-last user should be reminder-free",
        );
      }
    }
  });

  it("Anthropic: tool-tail input at sub-heartbeat depth round-trips unchanged", async () => {
    // Counterpart to the user-tail test above — confirms the skip branch
    // produces a wire identical to the un-enriched original (no extra
    // trailing user/text block injected mid-tool-loop). depth=3 is well
    // below the N=8 heartbeat boundary.
    const msgs = buildToolLoop(3);
    const baseline = await messagesToAnthropic(msgs);
    const enriched = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    const wire = await messagesToAnthropic(enriched);
    strictEqual(JSON.stringify(wire), JSON.stringify(baseline));

    // And the tail must still be the tool_result-bearing user (NOT a SR).
    const last = wire[wire.length - 1];
    strictEqual(last.role, "user");
    const lastBlocks = last.content as Array<{ type: string; text?: string }>;
    ok(lastBlocks.every((b) => b.type !== "text" || !b.text?.includes("<system-reminder>")));
  });

  it("OpenAI Chat-Completions: reminder ends up as the LAST user-role wire message", async () => {
    const msgs = buildToolLoopThenUser(3);
    const enriched = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    const wire = await messagesToOpenAI(enriched, STABLE);

    // wire[0] is the system message; everything else is conversation.
    strictEqual(wire[0].role, "system");

    const last = wire[wire.length - 1];
    strictEqual(last.role, "user");

    // For pure-text user content OpenAI returns a content array of
    // `{type:"text", text}` parts.
    const lastContent = last.content as Array<{ type: string; text?: string }>;
    ok(Array.isArray(lastContent));
    ok(lastContent.some((p) => p.type === "text" && p.text?.includes("<system-reminder>")));
  });

  it("OpenAI Chat-Completions: tool-tail (sub-heartbeat) input round-trips unchanged", async () => {
    const msgs = buildToolLoop(3); // depth=3 < N=8, safely in skip range
    const baseline = await messagesToOpenAI(msgs, STABLE);
    const enriched = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    const wire = await messagesToOpenAI(enriched, STABLE);
    strictEqual(JSON.stringify(wire), JSON.stringify(baseline));

    // Tail must be the tool message, not a SR user msg.
    const last = wire[wire.length - 1];
    strictEqual(last.role, "tool");
  });

  it("OpenAI Chat-Completions: heartbeat (depth=N=8) DOES inject reminder mid-loop", async () => {
    // The heartbeat is the only place the wire shape diverges from the
    // baseline mid-loop. After 8 completed tool rounds, exactly one
    // trailing reminder user message is appended.
    const msgs = buildToolLoop(8);
    const enriched = embedDynamicInLastUserContent(msgs, dynamicAt("12:00:00"));
    const wire = await messagesToOpenAI(enriched, STABLE);

    const last = wire[wire.length - 1];
    strictEqual(last.role, "user");
    const lastContent = last.content as Array<{ type: string; text?: string }>;
    ok(lastContent.some((p) => p.type === "text" && p.text?.includes("<system-reminder>")));
  });
});

// ─── Layer 3: cache-prefix stability simulation ──────────────────────────

describe("embedDynamicInLastUserContent (cache-prefix simulation)", () => {
  // Serialise the OpenAI wire body to bytes — we use OpenAI Chat-Completions
  // here because its wire format is simple JSON, and Anthropic / Gemini /
  // OpenAI Chat all share the same conceptual cache key (a byte-prefix of
  // the on-wire payload). The reduction holds across providers.
  async function wireBytes(
    msgs: LLMMessage[],
    ts: string,
    impl: "new" | "old",
  ): Promise<Buffer> {
    const enriched =
      impl === "new"
        ? embedDynamicInLastUserContent(msgs, dynamicAt(ts))
        : embedDynamicInLastUserContent_OLD(msgs, dynamicAt(ts));
    const wire = await messagesToOpenAI(enriched, STABLE);
    return Buffer.from(JSON.stringify(wire), "utf8");
  }

  function commonPrefixBytes(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a[i] === b[i]) i++;
    return i;
  }

  it("new impl: tool-loop turns share ≥80% of bytes with the previous turn", async () => {
    // Turn N (3 tool rounds) → Turn N+1 (4 tool rounds), with a different
    // dynamic timestamp on each call (mimics agent-status Current Time).
    const m3 = buildToolLoop(3);
    const m4 = buildToolLoop(4);

    const w3 = await wireBytes(m3, "12:00:00", "new");
    const w4 = await wireBytes(m4, "12:00:05", "new");

    const cp = commonPrefixBytes(w3, w4);
    const ratio = cp / w3.length;

    ok(
      ratio >= 0.8,
      `expected new-impl prefix overlap ≥80% of prior-turn bytes, got ${(ratio * 100).toFixed(1)}% (cp=${cp}, w3.length=${w3.length})`,
    );
  });

  it("old impl: tool-loop turns drop most prefix bytes due to dynamic poisoning", async () => {
    const m3 = buildToolLoop(3);
    const m4 = buildToolLoop(4);

    const w3 = await wireBytes(m3, "12:00:00", "old");
    const w4 = await wireBytes(m4, "12:00:05", "old");

    const cp = commonPrefixBytes(w3, w4);
    const ratio = cp / w3.length;

    // Old impl's poisoning point is messages[0]'s user content — once that
    // diverges, only the system message + a small framing JSON shell stays
    // matched. We expect overlap to be small relative to total prior bytes.
    ok(
      ratio < 0.3,
      `expected old-impl prefix overlap to collapse to <30%, got ${(ratio * 100).toFixed(1)}%`,
    );
  });

  it("benchmark: averaged across 10 consecutive tool turns, new ≫ old", async () => {
    const TURNS = 10;
    let newSum = 0;
    let oldSum = 0;

    for (let n = 1; n <= TURNS; n++) {
      const prev = buildToolLoop(n - 1);
      const cur = buildToolLoop(n);

      const wPrevNew = await wireBytes(prev, `t${n - 1}`, "new");
      const wCurNew = await wireBytes(cur, `t${n}`, "new");
      newSum += commonPrefixBytes(wPrevNew, wCurNew) / wCurNew.length;

      const wPrevOld = await wireBytes(prev, `t${n - 1}`, "old");
      const wCurOld = await wireBytes(cur, `t${n}`, "old");
      oldSum += commonPrefixBytes(wPrevOld, wCurOld) / wCurOld.length;
    }

    const newAvg = newSum / TURNS;
    const oldAvg = oldSum / TURNS;

    // Surfaced for human inspection on test runs.
    console.log(
      `[bench] avg prefix overlap — new=${(newAvg * 100).toFixed(1)}%  old=${(oldAvg * 100).toFixed(1)}%  Δ=${((newAvg - oldAvg) * 100).toFixed(1)}pp`,
    );

    ok(newAvg > 0.7, `new impl avg overlap should be >70%, got ${(newAvg * 100).toFixed(1)}%`);
    ok(oldAvg < 0.3, `old impl avg overlap should be <30%, got ${(oldAvg * 100).toFixed(1)}%`);
    ok(
      newAvg - oldAvg > 0.4,
      `expected new impl to beat old by ≥40 pp, got ${((newAvg - oldAvg) * 100).toFixed(1)} pp`,
    );
  });
});

// ─── Layer 4: Anthropic cache hit rate (excluding dynamic SR) ────────────
//
// Models the actual on-wire prompt organisation we ship to Anthropic:
//   1. stable system blocks → top-level `system` field (marker A on its tail);
//   2. messages → conversation array with marker B on the second-last user;
//   3. dynamic blocks → trailing `role:"user"` <system-reminder> message
//      that lives AFTER marker B → never in the cache prefix.
//
// Hit-rate definition used here (matches `cache_read / (cache_read +
// cache_creation)` from Anthropic billing, excluding the dynamic SR which
// counts as plain `input_tokens`):
//
//     hit_rate = bytes_matched(prev_cacheable, cur_cacheable)
//                ───────────────────────────────────────────────
//                              cur_cacheable_bytes
//
// where cacheable = system_field_bytes ⧺ messages[0..secondLastUser]
//   .content[0..markerBlockIdx]  (everything Anthropic stores under marker B).
//
// This is a CEILING measurement — same process, no 5-minute ephemeral
// expiry, no clock drift, no partial-eviction. It tells us whether the
// fix can in principle reach ≥95%.
describe("Anthropic cache hit rate, excluding dynamic SR (real prompt org)", () => {
  // Inlined replica of `annotateMessageCache` from anthropic.ts. We mirror it
  // here rather than exporting internals so the test exercises the exact same
  // marker-placement contract that production runs through.
  function findMarkerB(wire: any[]): { secondLastUserIdx: number; markerBlockIdx: number } {
    let lastUserIdx = -1;
    let secondLastUserIdx = -1;
    for (let i = wire.length - 1; i >= 0; i--) {
      if (wire[i].role === "user") {
        if (lastUserIdx === -1) lastUserIdx = i;
        else if (secondLastUserIdx === -1) {
          secondLastUserIdx = i;
          break;
        }
      }
    }
    let markerBlockIdx = -1;
    if (secondLastUserIdx >= 0) {
      const content = wire[secondLastUserIdx].content;
      if (Array.isArray(content) && content.length > 0) {
        markerBlockIdx = content.length - 1;
        while (
          markerBlockIdx >= 0 &&
          content[markerBlockIdx]?.type === "text" &&
          content[markerBlockIdx]?.text?.startsWith("<system-reminder>")
        ) {
          markerBlockIdx--;
        }
      }
    }
    return { secondLastUserIdx, markerBlockIdx };
  }

  // Bytes that fall under marker B's cache window — system field + message
  // wire array truncated at the marker block. This is the segment Anthropic
  // hashes for cache lookup / writeback.
  function cacheableBytes(systemField: any[], wire: any[]): Buffer {
    const { secondLastUserIdx, markerBlockIdx } = findMarkerB(wire);
    if (secondLastUserIdx < 0 || markerBlockIdx < 0) {
      return Buffer.from(JSON.stringify({ system: systemField, messages: [] }), "utf8");
    }
    const truncated = {
      ...wire[secondLastUserIdx],
      content: (wire[secondLastUserIdx].content as any[]).slice(0, markerBlockIdx + 1),
    };
    const cacheable = [...wire.slice(0, secondLastUserIdx), truncated];
    return Buffer.from(
      JSON.stringify({ system: systemField, messages: cacheable }),
      "utf8",
    );
  }

  function commonPrefixBytes(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a[i] === b[i]) i++;
    return i;
  }

  // Long stable system: ~3KB of soul prompt + ~10KB of tool docs. Realistic
  // size for an admin-class agent with several capability bundles loaded.
  function buildStableSystem(): SystemBlock[] {
    const soul =
      "<soul>You are Admin, a long-running framework evolver. " +
      "You coordinate sub-agents, run shell commands, edit code, and ".repeat(20) +
      "</soul>";
    const tools =
      "<tools>" +
      "shell(command): run shell. read_file(path): read file. write_file(path, content): write file. ".repeat(60) +
      "</tools>";
    return [
      { name: "soul", text: soul, cacheHint: "stable", priority: 0 },
      { name: "tools", text: tools, cacheHint: "stable", priority: 5 },
    ];
  }

  // Build a long stable history of N completed tool turns. Each tool_result
  // body is ~payloadBytes long to model substantial command output.
  function buildLongHistory(turns: number, payloadBytes: number): LLMMessage[] {
    const padding = "tool-output-line ".repeat(Math.ceil(payloadBytes / 17));
    const msgs: LLMMessage[] = [
      userMsg(
        "重构 agenteam_os 的 LLM 适配层，需要逐文件分析、跑测试，并给出每一步的进度摘要。",
      ),
    ];
    for (let i = 0; i < turns; i++) {
      msgs.push(
        assistantToolCall(`call_${i}`, "shell", { command: `analyze step ${i}` }),
      );
      msgs.push(
        toolResult(
          `call_${i}`,
          `step-${i} OK\n${padding.slice(0, payloadBytes)}`,
        ),
      );
    }
    return msgs;
  }

  function appendTurn(history: LLMMessage[], idx: number, payloadBytes: number): LLMMessage[] {
    const padding = "tool-output-line ".repeat(Math.ceil(payloadBytes / 17));
    return [
      ...history,
      assistantToolCall(`new_${idx}`, "shell", { command: `extra step ${idx}` }),
      toolResult(
        `new_${idx}`,
        `extra-${idx} OK\n${padding.slice(0, payloadBytes)}`,
      ),
    ];
  }

  // Build the full Anthropic wire shape (system field + messages) for a given
  // framework history at a given dynamic timestamp, using either the new or
  // old `embedDynamicInLastUserContent` impl.
  async function buildWire(
    history: LLMMessage[],
    system: SystemBlock[],
    ts: string,
    impl: "new" | "old",
  ): Promise<{ systemField: any[]; messages: any[] }> {
    const fn = impl === "new" ? embedDynamicInLastUserContent : embedDynamicInLastUserContent_OLD;
    const enriched = fn(history, dynamicAt(ts));
    const messages = await messagesToAnthropic(enriched);
    // We only feed STABLE blocks into the system field — dynamic ones are
    // routed through the trailing user message (new impl) or merged into a
    // message tail (old impl), neither lands in `system`.
    const systemField = system
      .filter((b) => (b.cacheHint ?? "dynamic") === "stable")
      .map((b, i, arr) => {
        const entry: any = { type: "text", text: b.text };
        if (i === arr.length - 1) entry.cache_control = { type: "ephemeral" };
        return entry;
      });
    return { systemField, messages };
  }

  async function hitRate(
    prevHistory: LLMMessage[],
    curHistory: LLMMessage[],
    system: SystemBlock[],
    tsPrev: string,
    tsCur: string,
    impl: "new" | "old",
  ): Promise<{ rate: number; prevBytes: number; curBytes: number; matched: number }> {
    const prev = await buildWire(prevHistory, system, tsPrev, impl);
    const cur = await buildWire(curHistory, system, tsCur, impl);
    const prevCacheable = cacheableBytes(prev.systemField, prev.messages);
    const curCacheable = cacheableBytes(cur.systemField, cur.messages);
    const matched = commonPrefixBytes(prevCacheable, curCacheable);
    return {
      rate: matched / curCacheable.length,
      prevBytes: prevCacheable.length,
      curBytes: curCacheable.length,
      matched,
    };
  }

  it("scenario A — 50 stable turns × 1KB, +1KB new turn → ≥ 95%", async () => {
    const system = buildStableSystem();
    const history = buildLongHistory(50, 1024);
    const cur = appendTurn(history, 0, 1024);
    const r = await hitRate(history, cur, system, "t0", "t1", "new");
    console.log(
      `[A] new=${(r.rate * 100).toFixed(2)}%  matched=${r.matched}B  cur_cacheable=${r.curBytes}B  Δ=${r.curBytes - r.matched}B`,
    );
    ok(r.rate >= 0.95, `expected ≥ 95%, got ${(r.rate * 100).toFixed(2)}%`);
  });

  it("scenario B — 100 stable turns × 2KB, +2KB new turn → ≥ 97%", async () => {
    const system = buildStableSystem();
    const history = buildLongHistory(100, 2048);
    const cur = appendTurn(history, 0, 2048);
    const r = await hitRate(history, cur, system, "t0", "t1", "new");
    console.log(
      `[B] new=${(r.rate * 100).toFixed(2)}%  matched=${r.matched}B  cur_cacheable=${r.curBytes}B  Δ=${r.curBytes - r.matched}B`,
    );
    ok(r.rate >= 0.97, `expected ≥ 97%, got ${(r.rate * 100).toFixed(2)}%`);
  });

  it("scenario C — 30 turns × 4KB, +500B tiny tool result → ≥ 95%", async () => {
    // Threshold note: pre-"skip-on-tool-tail" this scored ~99.46% because
    // appending a SR shifted marker B onto the latest tool_result (the
    // small 500B one), so `diff = small_new_tool_result`. With the skip
    // guard, marker B stays one tool back — diff is bounded by the
    // history's tail tool size (4KB), not by the new turn's size. Real
    // per-turn cache miss bytes are unchanged in steady state; this is
    // purely a measurement-instant artifact for this single-step scenario.
    const system = buildStableSystem();
    const history = buildLongHistory(30, 4096);
    const cur = appendTurn(history, 0, 500);
    const r = await hitRate(history, cur, system, "t0", "t1", "new");
    console.log(
      `[C] new=${(r.rate * 100).toFixed(2)}%  matched=${r.matched}B  cur_cacheable=${r.curBytes}B  Δ=${r.curBytes - r.matched}B`,
    );
    ok(r.rate >= 0.95, `expected ≥ 95%, got ${(r.rate * 100).toFixed(2)}%`);
  });

  it("scenario D — 20-turn rolling tool loop, average ≥ 95%", async () => {
    const system = buildStableSystem();
    let history = buildLongHistory(50, 1024);
    let total = 0;
    let count = 0;
    let minRate = 1;
    for (let i = 0; i < 20; i++) {
      const cur = appendTurn(history, i, 1024);
      const r = await hitRate(history, cur, system, `t${i}`, `t${i + 1}`, "new");
      total += r.rate;
      minRate = Math.min(minRate, r.rate);
      count++;
      history = cur;
    }
    const avg = total / count;
    console.log(
      `[D] avg=${(avg * 100).toFixed(2)}%  min_in_run=${(minRate * 100).toFixed(2)}%  turns=${count}`,
    );
    ok(avg >= 0.95, `expected avg ≥ 95%, got ${(avg * 100).toFixed(2)}%`);
    ok(minRate >= 0.93, `expected min ≥ 93%, got ${(minRate * 100).toFixed(2)}%`);
  });

  it("contrast — same scenario A under OLD impl drops far below 95%", async () => {
    const system = buildStableSystem();
    const history = buildLongHistory(50, 1024);
    const cur = appendTurn(history, 0, 1024);
    const newR = await hitRate(history, cur, system, "t0", "t1", "new");
    const oldR = await hitRate(history, cur, system, "t0", "t1", "old");
    console.log(
      `[contrast] new=${(newR.rate * 100).toFixed(2)}%  old=${(oldR.rate * 100).toFixed(2)}%  Δ=${((newR.rate - oldR.rate) * 100).toFixed(2)}pp`,
    );
    ok(newR.rate - oldR.rate > 0.5, `expected new to beat old by > 50pp`);
    ok(oldR.rate < 0.5, `expected old impl < 50%, got ${(oldR.rate * 100).toFixed(2)}%`);
  });
});
