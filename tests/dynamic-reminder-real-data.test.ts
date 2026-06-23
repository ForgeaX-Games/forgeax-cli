// @desc Replay-based benchmark for embedDynamicInLastUserContent.
//
// Replays a real `events-N.jsonl` segment from a populated agent session,
// reconstructing the framework `LLMMessage[]` state immediately BEFORE each
// `hook:assistantMessage` event (= one LLM call). For each adjacent pair
// (call N, call N+1) it measures the byte-level common-prefix length of the
// OpenAI Chat-Completions wire body produced by the new vs old impl.
//
// The metric is a faithful proxy for prompt-cache hit rate: every provider
// keys its cache on a byte-prefix of the on-wire payload (Anthropic with an
// explicit cache_control marker, OpenAI / Gemini / DeepSeek implicitly), so
// a higher shared prefix between consecutive turns ≡ higher cache hit rate.
//
// The test auto-skips when no EVENTS_PATH is set AND the default fixture
// path doesn't exist — keeps CI green when running outside the instance
// host. Set EVENTS_PATH=/path/to/events-N.jsonl to point at a different one.

import { describe, it } from "node:test";
import { ok } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { embedDynamicInLastUserContent } from "../src/llm/provider-utils.js";
import { messagesToOpenAI } from "../src/llm/openai-compat.js";
import { messagesToAnthropic } from "../src/llm/anthropic.js";
import type { LLMMessage, SystemBlock } from "../src/llm/types.js";

// ─── old-impl control (mirrors src/llm/provider-utils.ts pre-fix) ────────

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

// ─── events.jsonl → message-snapshot replay ──────────────────────────────

interface AnyContentPart {
  type: string;
  text?: string;
  [k: string]: unknown;
}

function normaliseContent(raw: unknown): AnyContentPart[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (Array.isArray(raw)) {
    return raw.map((p): AnyContentPart => {
      if (typeof p === "string") return { type: "text", text: p };
      if (p && typeof p === "object") return p as AnyContentPart;
      return { type: "text", text: String(p) };
    });
  }
  return [{ type: "text", text: "" }];
}

// Each `hook:assistantMessage` payload looks like:
//   { llmMessage: { role:"assistant", content:[...], thinking?, toolCalls? } }
// `hook:toolResult` payload looks like:
//   { toolCallId, toolName, content:[...], toolStatus:"completed", ... }
// `user/inbound_message` and `agent:admin/inbound_message` payload:
//   { llmMessage: {role, content, ...} }
function buildSnapshotsFromEvents(jsonl: string, cap = 200): LLMMessage[][] {
  const snapshots: LLMMessage[][] = [];
  const accum: LLMMessage[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = ev?.type;
    const payload = ev?.payload ?? {};

    if (type === "hook:assistantMessage") {
      // Snapshot BEFORE recording this assistant turn — this is the
      // `messages` argument the LLM saw when it produced the message.
      snapshots.push(accum.slice());
      const llm = payload.llmMessage;
      if (llm) {
        accum.push({
          role: "assistant",
          content: normaliseContent(llm.content) as LLMMessage["content"],
          ...(llm.thinking ? { thinking: llm.thinking } : {}),
          ...(Array.isArray(llm.toolCalls) ? { toolCalls: llm.toolCalls } : {}),
        });
      }
      if (snapshots.length >= cap) break;
      continue;
    }

    if (type === "hook:toolResult") {
      const tr: LLMMessage = {
        role: "tool",
        toolCallId: payload.toolCallId ?? payload.toolCall?.id ?? "_tool",
        toolName: payload.toolName ?? payload.toolCall?.name,
        toolStatus: "completed",
        content: normaliseContent(payload.content) as LLMMessage["content"],
      };
      accum.push(tr);
      continue;
    }

    if (type === "inbound_message" || type === "user_input") {
      const llm = payload.llmMessage;
      if (llm) {
        const role = llm.role === "assistant" ? "assistant" : "user";
        accum.push({
          role,
          content: normaliseContent(llm.content) as LLMMessage["content"],
        });
      } else if (typeof payload.content === "string" || Array.isArray(payload.content)) {
        accum.push({
          role: "user",
          content: normaliseContent(payload.content) as LLMMessage["content"],
        });
      }
      continue;
    }
  }

  return snapshots;
}

// ─── benchmark fixtures ──────────────────────────────────────────────────

// A modest stable system block (~200 bytes) — keeps the test focused on
// the conversation prefix-stability delta rather than padding numbers
// with a giant fake system field.
const STABLE: SystemBlock[] = [
  {
    name: "system-mock",
    text: "<soul>霜雪 admin — long-stable system prompt with framework rules.</soul>",
    cacheHint: "stable",
    priority: 0,
  },
];

const dynamicAt = (callSeq: number): SystemBlock[] => [
  {
    name: "agent-status",
    text:
      `<agent-status>\n` +
      `Current Time: 2026/05/09 ${String(Math.floor(callSeq / 60)).padStart(2, "0")}:${String(callSeq % 60).padStart(2, "0")}:00\n` +
      `Working Directory: /workspace\n` +
      `</agent-status>`,
    cacheHint: "dynamic",
    priority: 30,
  },
];

// ─── pick a real events.jsonl ────────────────────────────────────────────

const DEFAULT_EVENTS = [
  process.env.EVENTS_PATH,
  "/home/you/.agenteam/instances/framework_evolver/team/sessions/admin/s_1776418805303/events-19.jsonl",
].filter(Boolean) as string[];

function pickEvents(): string | null {
  for (const p of DEFAULT_EVENTS) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// ─── tests ───────────────────────────────────────────────────────────────

describe("real-data replay (events.jsonl)", { skip: pickEvents() == null }, () => {
  const path = pickEvents()!;

  it("loads and snapshots framework messages per LLM call", () => {
    const jsonl = readFileSync(path, "utf8");
    const snapshots = buildSnapshotsFromEvents(jsonl, 500);
    ok(snapshots.length > 30, `expected >30 snapshots, got ${snapshots.length}`);

    // Spot-check: snapshot lengths should be non-decreasing in stable
    // sub-sequences (compaction may reset, that's allowed).
    let increases = 0;
    for (let i = 1; i < snapshots.length; i++) {
      if (snapshots[i].length >= snapshots[i - 1].length) increases++;
    }
    ok(
      increases / (snapshots.length - 1) > 0.7,
      `expected ≥70% non-decreasing pairs, got ${increases}/${snapshots.length - 1}`,
    );
  });

  // Helper: byte-level common prefix length.
  function commonPrefix(a: Buffer, b: Buffer): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  // Provider-agnostic harness: takes any wire renderer (e.g. messagesToOpenAI
  // or messagesToAnthropic) and runs the new-vs-old prefix-overlap benchmark.
  async function benchProvider(
    label: string,
    renderWire: (msgs: LLMMessage[]) => Promise<unknown>,
    snapshots: LLMMessage[][],
  ): Promise<void> {
    let newSum = 0;
    let oldSum = 0;
    let pairCount = 0;
    let totalBytes = 0;

    // Tool-loop subset: pairs where the delta from prev → cur contains no
    // new framework `role: "user"` (the regime where the old bug is most
    // active and what triggers the long low-hit-rate streaks observed in
    // events-19.jsonl).
    let toolLoopNewSum = 0;
    let toolLoopOldSum = 0;
    let toolLoopPairs = 0;

    for (let k = 1; k < snapshots.length; k++) {
      const prev = snapshots[k - 1];
      const cur = snapshots[k];
      if (cur.length < prev.length) continue;

      const enrichedPrevNew = embedDynamicInLastUserContent(prev, dynamicAt(k - 1));
      const enrichedCurNew = embedDynamicInLastUserContent(cur, dynamicAt(k));
      const wPrevNew = Buffer.from(JSON.stringify(await renderWire(enrichedPrevNew)), "utf8");
      const wCurNew = Buffer.from(JSON.stringify(await renderWire(enrichedCurNew)), "utf8");

      const enrichedPrevOld = embedDynamicInLastUserContent_OLD(prev, dynamicAt(k - 1));
      const enrichedCurOld = embedDynamicInLastUserContent_OLD(cur, dynamicAt(k));
      const wPrevOld = Buffer.from(JSON.stringify(await renderWire(enrichedPrevOld)), "utf8");
      const wCurOld = Buffer.from(JSON.stringify(await renderWire(enrichedCurOld)), "utf8");

      const newRatio = commonPrefix(wPrevNew, wCurNew) / wCurNew.length;
      const oldRatio = commonPrefix(wPrevOld, wCurOld) / wCurOld.length;

      newSum += newRatio;
      oldSum += oldRatio;
      pairCount++;
      totalBytes += wCurNew.length;

      const delta = cur.slice(prev.length);
      if (!delta.some((m) => m.role === "user")) {
        toolLoopNewSum += newRatio;
        toolLoopOldSum += oldRatio;
        toolLoopPairs++;
      }
    }

    const newAvg = newSum / pairCount;
    const oldAvg = oldSum / pairCount;
    const newAvgTool = toolLoopPairs ? toolLoopNewSum / toolLoopPairs : 0;
    const oldAvgTool = toolLoopPairs ? toolLoopOldSum / toolLoopPairs : 0;

    console.log(
      `[${label}] pairs=${pairCount}  ` +
        `avg-prefix new=${(newAvg * 100).toFixed(1)}%  old=${(oldAvg * 100).toFixed(1)}%  ` +
        `Δ=${((newAvg - oldAvg) * 100).toFixed(1)}pp  ` +
        `avg wire≈${Math.round(totalBytes / pairCount / 1024)}KB`,
    );
    console.log(
      `[${label} tool-loop] pairs=${toolLoopPairs}  ` +
        `new=${(newAvgTool * 100).toFixed(1)}%  old=${(oldAvgTool * 100).toFixed(1)}%  ` +
        `Δ=${((newAvgTool - oldAvgTool) * 100).toFixed(1)}pp`,
    );

    ok(
      newAvg >= oldAvg - 0.001,
      `[${label}] NEW must not regress vs OLD on aggregate; got new=${newAvg.toFixed(3)} old=${oldAvg.toFixed(3)}`,
    );
    if (toolLoopPairs >= 5) {
      ok(
        newAvgTool - oldAvgTool >= 0.05,
        `[${label}] expected ≥5pp improvement in tool-loop regime; got Δ=${((newAvgTool - oldAvgTool) * 100).toFixed(1)}pp on ${toolLoopPairs} pairs`,
      );
    }
  }

  it("OpenAI Chat-Completions wire: NEW vs OLD prefix overlap", async () => {
    const jsonl = readFileSync(path, "utf8");
    const snapshots = buildSnapshotsFromEvents(jsonl, 200);
    await benchProvider("openai", (m) => messagesToOpenAI(m, STABLE), snapshots);
  });

  it("Anthropic wire: NEW vs OLD prefix overlap (admin's actual provider)", async () => {
    const jsonl = readFileSync(path, "utf8");
    const snapshots = buildSnapshotsFromEvents(jsonl, 200);
    await benchProvider("anthropic", (m) => messagesToAnthropic(m), snapshots);
  });
});
