/** checkpoint 模块单测 —— SnapshotStore(CAS)/ rewind-mask 语义。
 *  对应测试用例文档 A/B 组的纯逻辑部分;走真实 fs(tmp 目录),不 mock。 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotStore, lcsDiffCounts } from "../src/checkpoint/snapshot-store";
import { applyRewindMask, findPendingRewind } from "../src/checkpoint/rewind-mask";
import type { StoredEvent } from "../src/ledger/types";

let workDir: string;
let storeDir: string;
let gameDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  storeDir = join(workDir, "store");
  gameDir = join(workDir, "game");
  mkdirSync(gameDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = join(gameDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function countBlobs(store: SnapshotStore): number {
  const blobs = join(store.storeRoot, "blobs");
  if (!existsSync(blobs)) return 0;
  let n = 0;
  for (const d of readdirSync(blobs)) n += readdirSync(join(blobs, d)).length;
  return n;
}

describe("SnapshotStore", () => {
  test("snapshot 覆盖全目录 + ignore 规则", () => {
    write("main.ts", "console.log(1)\n");
    write("src/util.ts", "export const x = 1\n");
    mkdirSync(join(gameDir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(gameDir, "node_modules/pkg/index.js"), "ignored");
    writeFileSync(join(gameDir, ".DS_Store"), "ignored");
    const store = new SnapshotStore(storeDir);
    const m = store.snapshot(gameDir);
    expect(Object.keys(m.files).sort()).toEqual(["main.ts", "src/util.ts"]);
    expect(store.loadManifest(m.id)?.id).toBe(m.id);
  });

  test("CAS 去重:未变文件零新增 blob;相同内容跨版本只存一份", () => {
    write("a.ts", "AAA\n");
    write("b.ts", "BBB\n");
    const store = new SnapshotStore(storeDir);
    store.snapshot(gameDir);
    expect(countBlobs(store)).toBe(2);
    write("b.ts", "BBB2\n");
    store.snapshot(gameDir);
    expect(countBlobs(store)).toBe(3); // 只多 b 的新版本
    write("b.ts", "BBB\n"); // 改回老内容
    store.snapshot(gameDir);
    expect(countBlobs(store)).toBe(3); // 内容寻址:不重复存
  });

  test("restore:跨版本一次到位,含删除/新增语义", () => {
    write("a.ts", "v1-a\n");
    write("gone.ts", "will-be-deleted\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);

    // turn1: 改 a、删 gone、加 new
    write("a.ts", "v2-a\n");
    rmSync(join(gameDir, "gone.ts"));
    write("deep/new.ts", "added-later\n");
    const m2 = store.snapshot(gameDir);

    // 回退到 m1:a 还原、gone 复活、new 删除(空目录清理)
    const res = store.restore(gameDir, m1);
    expect(readFileSync(join(gameDir, "a.ts"), "utf-8")).toBe("v1-a\n");
    expect(readFileSync(join(gameDir, "gone.ts"), "utf-8")).toBe("will-be-deleted\n");
    expect(existsSync(join(gameDir, "deep/new.ts"))).toBe(false);
    expect(existsSync(join(gameDir, "deep"))).toBe(false);
    expect(res.written.sort()).toEqual(["a.ts", "gone.ts"]);
    expect(res.deleted).toEqual(["deep/new.ts"]);

    // 再向前跳回 m2(撤销回退的等价操作)
    store.restore(gameDir, m2);
    expect(readFileSync(join(gameDir, "a.ts"), "utf-8")).toBe("v2-a\n");
    expect(existsSync(join(gameDir, "gone.ts"))).toBe(false);
    expect(readFileSync(join(gameDir, "deep/new.ts"), "utf-8")).toBe("added-later\n");
  });

  test("只写差异文件(未变文件 mtime 不动)", async () => {
    write("stable.ts", "same\n");
    write("hot.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);
    write("hot.ts", "v2\n");
    const before = statSync(join(gameDir, "stable.ts")).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const res = store.restore(gameDir, m1);
    expect(res.written).toEqual(["hot.ts"]);
    expect(statSync(join(gameDir, "stable.ts")).mtimeMs).toBe(before);
  });

  test("exclude:脏文件保留(不写回不删除)", () => {
    write("a.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);
    write("a.ts", "user-edit\n");
    write("user-new.ts", "user-created\n");
    const res = store.restore(gameDir, m1, { exclude: new Set(["a.ts", "user-new.ts"]) });
    expect(readFileSync(join(gameDir, "a.ts"), "utf-8")).toBe("user-edit\n");
    expect(existsSync(join(gameDir, "user-new.ts"))).toBe(true);
    expect(res.skippedDirty.sort()).toEqual(["a.ts", "user-new.ts"]);
  });

  test("only:局部恢复(这些文件也回退 / 撤销)", () => {
    write("a.ts", "v1\n");
    write("b.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);
    write("a.ts", "v2\n");
    write("b.ts", "v2\n");
    store.restore(gameDir, m1, { only: new Set(["a.ts"]) });
    expect(readFileSync(join(gameDir, "a.ts"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(gameDir, "b.ts"), "utf-8")).toBe("v2\n"); // 不在 only 内,不动
  });

  test("diffStats:行级统计 + 二进制按变更计数", () => {
    write("code.ts", "line1\nline2\nline3\n");
    writeFileSync(join(gameDir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);
    write("code.ts", "line1\nCHANGED\nline3\nline4\n");
    writeFileSync(join(gameDir, "bin.dat"), Buffer.from([0, 9, 9]));
    const stats = store.diffStats(gameDir, m1);
    expect(stats.filesChanged.sort()).toEqual(["bin.dat", "code.ts"]);
    expect(stats.insertions).toBe(1);
    expect(stats.deletions).toBe(2);
    expect(stats.binaryOrLarge).toBe(1);
  });

  test("diffStats.files:逐文件 status / 行数 / binary", () => {
    write("code.ts", "a\nb\nc\n");
    write("old.ts", "x\n");
    writeFileSync(join(gameDir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(gameDir);

    // 改 code、删 old、增 extra、改 bin —— 回到 m1 视角:code=改,old=新增(写回),
    // extra=删除,bin=改(二进制)。
    write("code.ts", "a\nB\nc\nd\n");
    rmSync(join(gameDir, "old.ts"));
    write("extra.ts", "new1\nnew2\n");
    writeFileSync(join(gameDir, "bin.dat"), Buffer.from([9, 9]));

    const stats = store.diffStats(gameDir, m1);
    const byPath = Object.fromEntries(stats.files.map((f) => [f.path, f]));

    expect(stats.files.length).toBe(stats.filesChanged.length);
    expect(byPath["code.ts"]).toMatchObject({ status: "modified", binary: false });
    expect(byPath["old.ts"]).toMatchObject({ status: "added", binary: false });
    expect(byPath["extra.ts"]).toMatchObject({ status: "deleted", binary: false });
    expect(byPath["bin.dat"]).toMatchObject({ status: "modified", binary: true });
    // 行级统计仍与聚合一致
    const sumIns = stats.files.reduce((n, f) => n + f.insertions, 0);
    const sumDel = stats.files.reduce((n, f) => n + f.deletions, 0);
    expect(sumIns).toBe(stats.insertions);
    expect(sumDel).toBe(stats.deletions);
  });
});

describe("lcsDiffCounts", () => {
  test("公共前后缀剥离 + 计数", () => {
    expect(lcsDiffCounts(["a", "b", "c"], ["a", "x", "c"])).toEqual({ insertions: 1, deletions: 1 });
    expect(lcsDiffCounts([], ["a", "b"])).toEqual({ insertions: 2, deletions: 0 });
    expect(lcsDiffCounts(["a"], ["a"])).toEqual({ insertions: 0, deletions: 0 });
  });
});

// ─── rewind-mask ────────────────────────────────────────────────────────────

function ev(type: string, ts: number, payload?: Record<string, unknown>): StoredEvent {
  return { type, ts, payload };
}

describe("applyRewindMask", () => {
  const base: StoredEvent[] = [
    ev("user_input", 100, { msgId: "m1", content: "hi" }),
    ev("hook:assistantMessage", 110),
    ev("user_input", 200, { msgId: "m2", content: "again" }),
    ev("hook:assistantMessage", 210),
  ];

  test("无 boundary 原样返回(热路径)", () => {
    expect(applyRewindMask(base)).toBe(base);
  });

  test("活跃 boundary 屏蔽 [目标..boundary]", () => {
    const events = [...base, ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m2", targetTs: 200 })];
    const out = applyRewindMask(events);
    expect(out.map((e) => e.ts)).toEqual([100, 110]);
  });

  test("被 cancel 的 boundary 区间重新可见,boundary/cancel 自身隐藏", () => {
    const events = [
      ...base,
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m2", targetTs: 200 }),
      ev("rewind_cancel", 310, { boundaryId: "b1" }),
    ];
    const out = applyRewindMask(events);
    expect(out.map((e) => e.ts)).toEqual([100, 110, 200, 210]);
  });

  test("多重 boundary(挂起态再回退)以并集屏蔽", () => {
    const events = [
      ...base,
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m2", targetTs: 200 }),
      ev("rewind_boundary", 320, { boundaryId: "b2", targetMsgId: "m1", targetTs: 100 }),
    ];
    const out = applyRewindMask(events);
    expect(out).toEqual([]);
  });

  test("子 agent 无 user_input → targetTs fallback", () => {
    const events = [
      ev("inbound_message", 150, {}),
      ev("hook:assistantMessage", 220),
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m2", targetTs: 200 }),
    ];
    const out = applyRewindMask(events);
    expect(out.map((e) => e.ts)).toEqual([150]);
  });

  test("keepBoundaryVisible:挂起 boundary 区间保留(UI 置灰用)", () => {
    const events = [...base, ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m2", targetTs: 200 })];
    const out = applyRewindMask(events, { keepBoundaryVisible: "b1" });
    expect(out.map((e) => e.ts)).toEqual([100, 110, 200, 210]);
  });
});

describe("findPendingRewind", () => {
  test("boundary 后出现 user_input → 已定格,无挂起", () => {
    const events = [
      ev("user_input", 100, { msgId: "m1" }),
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m1", targetTs: 100 }),
      ev("user_input", 400, { msgId: "m3" }),
    ];
    expect(findPendingRewind(events)).toBeNull();
  });

  test("挂起态返回最新未 cancel 的 boundary", () => {
    const events = [
      ev("user_input", 100, { msgId: "m1" }),
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m1", targetTs: 100 }),
      ev("rewind_cancel", 310, { boundaryId: "b1" }),
      ev("rewind_boundary", 320, { boundaryId: "b2", targetMsgId: "m1", targetTs: 100 }),
    ];
    expect(findPendingRewind(events)?.boundaryId).toBe("b2");
  });

  test("cancel 后无新 boundary → 无挂起", () => {
    const events = [
      ev("user_input", 100, { msgId: "m1" }),
      ev("rewind_boundary", 300, { boundaryId: "b1", targetMsgId: "m1", targetTs: 100 }),
      ev("rewind_cancel", 310, { boundaryId: "b1" }),
    ];
    expect(findPendingRewind(events)).toBeNull();
  });
});
