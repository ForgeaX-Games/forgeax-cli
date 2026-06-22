import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";

import { sanitizeInvalidSurrogates, sanitizeUnknownStrings } from "../src/unicode/sanitize.js";
import { normalizeContent, prepareMessagesForModel } from "../src/message/modality.js";
import { eventToSessionMessage } from "../src/message/message-ingress.js";
import { deleteAt, insertAt, insertPasteAt, type InputSegment } from "../src/channels/input-segments.js";

describe("unicode surrogate sanitization", () => {
  it("replaces unpaired surrogate while preserving valid emoji pair", () => {
    const bad = "abc\udd47z";
    strictEqual(sanitizeInvalidSurrogates(bad), "abc\ufffdz");

    const ok = "a😀b";
    strictEqual(sanitizeInvalidSurrogates(ok), ok);
  });

  it("sanitizes nested strings deeply", () => {
    const input = { a: "x\udd47", b: ["y", { c: "\ud83d" }] };
    deepStrictEqual(sanitizeUnknownStrings(input), { a: "x\ufffd", b: ["y", { c: "\ufffd" }] });
  });
});

describe("core message normalization sanitizes text", () => {
  it("normalizes invalid surrogates from string content", () => {
    deepStrictEqual(normalizeContent("hi\udd47"), [{ type: "text", text: "hi\ufffd" }]);
  });

  it("sanitizes outbound model messages in prepareMessagesForModel", () => {
    const messages = [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "go\udd47" }],
    }];
    const out = prepareMessagesForModel(messages, ["text"]);
    strictEqual(out[0]!.content[0]!.type, "text");
    strictEqual((out[0]!.content[0] as { text: string }).text, "go\ufffd");
  });

  it("sanitizes through standard message-ingress chain", () => {
    const msg = eventToSessionMessage({
      source: "user",
      type: "user_input",
      payload: { content: "hello\udd47world" },
      ts: Date.now(),
    });
    strictEqual(msg?.role, "user");
    strictEqual(msg?.content[0]?.type, "text");
    strictEqual((msg?.content[0] as { text: string }).text, "hello\ufffdworld");
  });
});

describe("input-segments surrogate-safe splitting", () => {
  it("insertAt does not split surrogate pair", () => {
    const segs: InputSegment[] = [{ type: "text", content: "a😀b" }];
    insertAt(segs, 2, "X"); // position between pair units should normalize to safe boundary
    strictEqual((segs[0] as { content: string }).content, "a😀Xb");
  });

  it("insertPasteAt does not split surrogate pair", () => {
    const segs: InputSegment[] = [{ type: "text", content: "a😀b" }];
    insertPasteAt(segs, 2, "YY");
    const text = segs
      .filter((s): s is Extract<InputSegment, { type: "text" | "paste" }> => s.type === "text" || s.type === "paste")
      .map((s) => s.content)
      .join("");
    strictEqual(text, "a😀YYb");
  });

  it("deleteAt deletes full surrogate pair atomically", () => {
    const segs: InputSegment[] = [{ type: "text", content: "a😀b" }];
    deleteAt(segs, 1); // at high surrogate position
    strictEqual((segs[0] as { content: string }).content, "ab");
  });
});
