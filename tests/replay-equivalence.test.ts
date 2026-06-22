// @desc End-to-end replay equivalence tests for WAL → state reconstruction
import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { replaySystemSnapshot, diffSystemBlocks, type StoredEvent } from "../src/context-window/system-snapshot.js";
import { eventsToMessages } from "../src/context-window/history-pipeline.js";
import type { SystemBlock } from "../src/llm/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSystemPromptEvent(
  changed: SystemBlock[],
  removed: string[] = [],
  ts = Date.now(),
): StoredEvent {
  return {
    type: "hook:systemPrompt",
    ts,
    source: "test",
    agent: "test-agent",
    payload: {
      changed,
      ...(removed.length > 0 ? { removed } : {}),
    },
  };
}

function makeMsgEvent(
  role: "user" | "assistant" | "tool",
  text: string,
  ts = Date.now(),
): StoredEvent {
  return {
    type: role === "user" ? "user_input" : "hook:assistantMessage",
    ts,
    source: role === "user" ? "user" : "agent:test",
    agent: "test-agent",
    payload: {
      llmMessage: { role, content: [{ type: "text" as const, text }], ts },
    },
  };
}

// ─── System Snapshot Replay Tests ───────────────────────────────────────────

describe("replaySystemSnapshot", () => {
  it("empty events → empty snapshot", () => {
    const result = replaySystemSnapshot([]);
    strictEqual(result.size, 0);
  });

  it("single systemPrompt event replays correctly", () => {
    const blocks: SystemBlock[] = [
      { name: "soul", text: "You are a helpful agent.", priority: 0 },
      { name: "tools", text: "Available tools: search", priority: 130 },
    ];
    const events = [makeSystemPromptEvent(blocks)];
    const snapshot = replaySystemSnapshot(events);

    strictEqual(snapshot.size, 2);
    strictEqual(snapshot.get("soul")?.text, "You are a helpful agent.");
    strictEqual(snapshot.get("tools")?.text, "Available tools: search");
  });

  it("incremental deltas accumulate correctly", () => {
    const events = [
      makeSystemPromptEvent([
        { name: "soul", text: "v1", priority: 0 },
        { name: "tools", text: "tools-v1", priority: 130 },
      ]),
      makeSystemPromptEvent([
        { name: "tools", text: "tools-v2", priority: 130 },
      ]),
      makeSystemPromptEvent([
        { name: "env", text: "env-data", priority: 40 },
      ]),
    ];
    const snapshot = replaySystemSnapshot(events);

    strictEqual(snapshot.size, 3);
    strictEqual(snapshot.get("soul")?.text, "v1");
    strictEqual(snapshot.get("tools")?.text, "tools-v2");
    strictEqual(snapshot.get("env")?.text, "env-data");
  });

  it("removed blocks are deleted from snapshot", () => {
    const events = [
      makeSystemPromptEvent([
        { name: "soul", text: "v1", priority: 0 },
        { name: "tools", text: "tools-v1", priority: 130 },
        { name: "env", text: "env-v1", priority: 40 },
      ]),
      makeSystemPromptEvent([], ["tools"]),
    ];
    const snapshot = replaySystemSnapshot(events);

    strictEqual(snapshot.size, 2);
    strictEqual(snapshot.has("tools"), false);
    strictEqual(snapshot.get("soul")?.text, "v1");
    strictEqual(snapshot.get("env")?.text, "env-v1");
  });

  it("non-systemPrompt events are ignored", () => {
    const events: StoredEvent[] = [
      makeSystemPromptEvent([{ name: "soul", text: "v1", priority: 0 }]),
      makeMsgEvent("user", "hello"),
      makeMsgEvent("assistant", "hi there"),
    ];
    const snapshot = replaySystemSnapshot(events);

    strictEqual(snapshot.size, 1);
    strictEqual(snapshot.get("soul")?.text, "v1");
  });
});

// ─── diffSystemBlocks Tests ─────────────────────────────────────────────────

describe("diffSystemBlocks", () => {
  it("identical state → null delta", () => {
    const blocks: SystemBlock[] = [
      { name: "soul", text: "v1", priority: 0 },
    ];
    const snapshot = replaySystemSnapshot([makeSystemPromptEvent(blocks)]);
    const delta = diffSystemBlocks(snapshot, blocks);

    strictEqual(delta, null);
  });

  it("detects changed blocks", () => {
    const snapshot = replaySystemSnapshot([
      makeSystemPromptEvent([{ name: "soul", text: "v1", priority: 0 }]),
    ]);
    const current: SystemBlock[] = [
      { name: "soul", text: "v2", priority: 0 },
    ];
    const delta = diffSystemBlocks(snapshot, current);

    strictEqual(delta?.changed.length, 1);
    strictEqual(delta?.changed[0].text, "v2");
    strictEqual(delta?.removed.length, 0);
  });

  it("detects removed blocks", () => {
    const snapshot = replaySystemSnapshot([
      makeSystemPromptEvent([
        { name: "soul", text: "v1", priority: 0 },
        { name: "tools", text: "t1", priority: 130 },
      ]),
    ]);
    const current: SystemBlock[] = [
      { name: "soul", text: "v1", priority: 0 },
    ];
    const delta = diffSystemBlocks(snapshot, current);

    strictEqual(delta?.changed.length, 0);
    deepStrictEqual(delta?.removed, ["tools"]);
  });

  it("detects new blocks as changed", () => {
    const snapshot = replaySystemSnapshot([
      makeSystemPromptEvent([{ name: "soul", text: "v1", priority: 0 }]),
    ]);
    const current: SystemBlock[] = [
      { name: "soul", text: "v1", priority: 0 },
      { name: "env", text: "new-env", priority: 40 },
    ];
    const delta = diffSystemBlocks(snapshot, current);

    strictEqual(delta?.changed.length, 1);
    strictEqual(delta?.changed[0].name, "env");
    strictEqual(delta?.removed.length, 0);
  });
});

// ─── Replay round-trip equivalence ──────────────────────────────────────────

describe("replay round-trip equivalence", () => {
  it("replay(events produced by diff) equals the original current state", () => {
    const initial: SystemBlock[] = [
      { name: "soul", text: "soul-v1", priority: 0 },
      { name: "tools", text: "tools-v1", priority: 130 },
    ];

    const allEvents: StoredEvent[] = [makeSystemPromptEvent(initial)];

    const turn2Blocks: SystemBlock[] = [
      { name: "soul", text: "soul-v1", priority: 0 },
      { name: "tools", text: "tools-v2", priority: 130 },
      { name: "env", text: "env-v1", priority: 40 },
    ];

    const snap1 = replaySystemSnapshot(allEvents);
    const delta1 = diffSystemBlocks(snap1, turn2Blocks)!;
    allEvents.push(makeSystemPromptEvent(delta1.changed, delta1.removed));

    const turn3Blocks: SystemBlock[] = [
      { name: "soul", text: "soul-v2", priority: 0 },
      { name: "env", text: "env-v1", priority: 40 },
    ];

    const snap2 = replaySystemSnapshot(allEvents);
    const delta2 = diffSystemBlocks(snap2, turn3Blocks)!;
    allEvents.push(makeSystemPromptEvent(delta2.changed, delta2.removed));

    const finalSnapshot = replaySystemSnapshot(allEvents);

    strictEqual(finalSnapshot.size, turn3Blocks.length);
    for (const block of turn3Blocks) {
      strictEqual(finalSnapshot.get(block.name)?.text, block.text);
    }
  });
});

// ─── Message history replay Tests ───────────────────────────────────────────

describe("eventsToMessages", () => {
  it("empty events → empty messages", () => {
    const msgs = eventsToMessages([]);
    strictEqual(msgs.length, 0);
  });

  it("extracts llmMessage from events in order", () => {
    const events = [
      makeMsgEvent("user", "hello", 1000),
      makeMsgEvent("assistant", "hi there", 2000),
      makeMsgEvent("user", "how are you?", 3000),
    ];
    const msgs = eventsToMessages(events);

    strictEqual(msgs.length, 3);
    strictEqual(msgs[0].role, "user");
    strictEqual(msgs[1].role, "assistant");
    strictEqual(msgs[2].role, "user");
  });

  it("skips events without llmMessage", () => {
    const events: StoredEvent[] = [
      makeMsgEvent("user", "hello"),
      makeSystemPromptEvent([{ name: "soul", text: "v1", priority: 0 }]),
      makeMsgEvent("assistant", "response"),
    ];
    const msgs = eventsToMessages(events);

    strictEqual(msgs.length, 2);
    strictEqual(msgs[0].role, "user");
    strictEqual(msgs[1].role, "assistant");
  });
});
