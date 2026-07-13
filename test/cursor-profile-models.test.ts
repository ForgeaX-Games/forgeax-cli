// parseCursorModelList / probeCursorModels — cursor-profile 模型目录单测。
//
// 契约:
// - `id - 描述` 行提取描述作 label;`(current|default)` 注记剥掉;bullet/序号剥掉;
//   表头噪声词(Available/models/…)过滤;重复 id 去重。
// - probeCursorModels 对不存在的 binary reject(编排层降级 last-known → static)。

import { describe, expect, test } from "bun:test";
import { parseCursorModelList, probeCursorModels } from "../src/kernel/cursor-profile";

describe("parseCursorModelList", () => {
  test("extracts ids + descriptions-as-labels, strips annotations, dedupes, filters headers", () => {
    const out = parseCursorModelList([
      "Available models",
      "",
      "auto - Auto (default)",
      "gpt-5.3-codex-low - Codex 5.3 Low",
      "* claude-opus-4-8-thinking-high",
      "1. sonnet-4.6 (default)",
      "sonnet-4.6",
      "model",
    ].join("\n"));
    expect(out).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low" },
      { id: "claude-opus-4-8-thinking-high" },
      { id: "sonnet-4.6" },
    ]);
  });
});

describe("probeCursorModels", () => {
  test("missing binary → rejects (resolver degrades)", async () => {
    const prev = process.env.CURSOR_CLI_PATH;
    process.env.CURSOR_CLI_PATH = "/nonexistent/cursor-agent-for-test";
    try {
      await expect(probeCursorModels(3_000)).rejects.toThrow(/spawn-failed|exit/);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_CLI_PATH;
      else process.env.CURSOR_CLI_PATH = prev;
    }
  });
});
