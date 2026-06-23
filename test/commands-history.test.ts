// @desc 历史记录命令端到端测试（fetch_session_events / fetch_blob）
//
// 镜像 agenteam-os-ref `commands/sessions.ts::fetch_session_events` +
// `commands/blob.ts` 的语义，但适配 forgeax `(sid, agentPath)` 双参数。
//
// 关键不变量：
//   1. fetch_session_events 走 raw 反扫，**sentinel pass-through**（不 reinflate
//      blob 字段），用 64KB+ string 触发 walkAndExternalize，验证返回的 JSONL
//      里 payload 字段确实是 sentinel obj 而不是原文。
//   2. fetch_blob 取该 sentinel 的 sha256 能拿回原始 bytes（base64 解码后等于
//      原 string）；非法 sha256 / 越界 path / 不存在 blob 全部走 ok:false。
//   3. compact_boundary 反扫边界：手动塞一条 type=compact_boundary 的 event，
//      验证跨 shard 时遇 boundary 即停（不再回读更老的 shard）。
//
// 注：ref 还有 `commands/compact.ts` 派发 agent_command；forgeax 这边
// ConsciousAgent 还没接 compact tool，移植该命令也只是死代码，等真 compact
// tool 实装后再补。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Hono } from "hono";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager, getSessionManager } from "../src/core/session-manager";
import { createCommandsApiRouter } from "../src/api/commands";
import type { Event } from "../src/core/types";

let userRoot: string;
let app: Hono;

function mountApp(): Hono {
  const a = new Hono();
  a.route("/api/commands", createCommandsApiRouter());
  return a;
}

interface CallResult { status: number; json: any }
async function exec(name: string, args: unknown[] = []): Promise<CallResult> {
  const res = await app.fetch(new Request(`http://localhost/api/commands/${name}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  }));
  return { status: res.status, json: await res.json() };
}
async function query(name: string, args: unknown[] = []): Promise<CallResult> {
  const res = await app.fetch(new Request(`http://localhost/api/commands/${name}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  }));
  return { status: res.status, json: await res.json() };
}

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-cmd-hist-"));
  resetPathManager();
  await resetSessionManager();
  const pm = initPathManager({ userRoot });
  initSessionManager(pm);
  app = mountApp();
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

async function makeSidWithRootAgent(): Promise<{ sid: string; agentPath: string }> {
  // session 容器走 SessionManager（不再有 commands/sessions 模块）—— 用户钉死
  // 的边界：容器 CRUD 走 REST/SM，commands 只承载 agent 树 + 历史查询。
  const session = await getSessionManager().create({
    defaultDir: "demo-game",
    displayName: "hist",
  });
  // scaffold root agent on disk —— hist 测试不跑 LLM，只读 ledger，所以不必
  // attach root agent；EventLedger 第一次 append 就建 events-1.jsonl。
  const layer = getPathManager().session(session.sid).agent("root");
  mkdirSync(layer.root(), { recursive: true });
  writeFileSync(layer.agentJson(), "{}\n", "utf-8");
  return { sid: session.sid, agentPath: "root" };
}

/** 直接调 EventLedger.append 写盘 —— 不绕 EventBus observer，因为
 *  `_bindLedgerPersistence` 需要 `tree.get(agentPath)` 命中，而 AgentTree 是
 *  fs-watcher driven 的（等不起）。`fetch_session_events` 是纯盘读，本来就
 *  跟 bus 解耦；测试构造直接走 ledger.append 更直白也更稳。
 *
 *  这是与 ref `commands/sessions.test` 同样的做法 —— ref 测试也是直接构造
 *  events.jsonl 文本，不模拟 scheduler / bus 那一长串。 */
async function appendEvent(sid: string, agentPath: string, event: Event): Promise<void> {
  const session = await getSessionManager().open(sid);
  session.getOrCreateLedger(agentPath).append(event);
}

describe("commands/history — fetch_session_events / fetch_blob", () => {
  test("list 命令清单 含 fetch_session_events + fetch_blob", async () => {
    const r = await app.fetch(new Request("http://localhost/api/commands"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { commands: Array<{ name: string }> };
    const names = j.commands.map((c) => c.name);
    expect(names).toContain("fetch_session_events");
    expect(names).toContain("fetch_blob");
  });

  test("fetch_session_events 空 ledger → 空字符串", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    const r = await query("fetch_session_events", [sid, agentPath]);
    expect(r.status).toBe(200);
    expect(r.json.result.ok).toBe(true);
    expect(r.json.result.data).toBe("");
  });

  test("fetch_session_events 多条 → JSONL，按时间顺序", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "msg-1" }, ts: 1_000,
    });
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "msg-2" }, ts: 2_000,
    });

    const r = await query("fetch_session_events", [sid, agentPath]);
    expect(r.status).toBe(200);
    const jsonl = r.json.result.data as string;
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].payload.content).toBe("msg-1");
    expect(lines[1].payload.content).toBe("msg-2");
    expect(lines[1].ts).toBe(2_000);
  });

  test("fetch_session_events 反扫遇 compact_boundary 即停（不跨 shard，但单 shard 内全量返回）", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    // 三条历史 + 一条 compact_boundary + 一条 post-boundary user_input
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "old-1" }, ts: 1_000,
    });
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "old-2" }, ts: 2_000,
    });
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "old-3" }, ts: 3_000,
    });
    await appendEvent(sid, agentPath, {
      // 未来 compact tool 会发 type:"compact_boundary" 的事件；这里手 inject
      // 验证反扫语义。
      source: "system", type: "compact_boundary", to: agentPath, handoff: "silent",
      payload: { summary: "compacted up to here" }, ts: 4_000,
    });
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: "post-compact" }, ts: 5_000,
    });

    const r = await query("fetch_session_events", [sid, agentPath]);
    expect(r.status).toBe(200);
    const lines = (r.json.result.data as string)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // hasCompactBoundary 反扫**只在 shard 边界生效** —— 跟 ref `commands/sessions.ts`
    // 同语义：单 shard 内全量返回，跨 shard 时遇 boundary 即停（不再往老 shard 看）。
    // 5 个事件同住一个 shard，所以全量回来。下游消费者（XML renderer / context-window）
    // 再按 boundary 在 result 内部 slice 拿到 post-boundary tail。
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.type)).toEqual([
      "user_input",
      "user_input",
      "user_input",
      "compact_boundary",
      "user_input",
    ]);
    expect(lines[3].type).toBe("compact_boundary");
    expect(lines[4].payload.content).toBe("post-compact");
  });

  test("fetch_session_events 跨 shard：老 shard 中有 compact_boundary 时不再继续往更老的 shard 看", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    // 单条事件无法触发 5MB rotation。直接捅 EventLedger 内部 `_currentShard++`
    // 不优雅，**写两个 shard 文件**绕一切，纯 fs 黑盒（外部 surface 行为正是
    // 这套 readEventsFromTailRaw 关心的）。
    const eventsDir = getPathManager().session(sid).agent(agentPath).eventsDir();
    mkdirSync(eventsDir, { recursive: true });
    const old = [
      { type: "user_input", source: "user", ts: 1, payload: { content: "very-old" } },
      { type: "compact_boundary", source: "system", ts: 2, payload: { summary: "X" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const newer = [
      { type: "user_input", source: "user", ts: 3, payload: { content: "after-compact" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(eventsDir, "events-1.jsonl"), old, "utf-8");
    writeFileSync(join(eventsDir, "events-2.jsonl"), newer, "utf-8");

    // 再在前面塞一个 events-0.jsonl 模拟「更老的归档 shard」—— 反扫遇到 boundary
    // 后停掉，events-0 不应被读到。注意 SHARD_RE = /^events-(\d+)\.jsonl$/ 接受
    // 0 起始（initShardIndex 用的是 `max`）。
    writeFileSync(
      join(eventsDir, "events-0.jsonl"),
      JSON.stringify({ type: "user_input", source: "user", ts: 0, payload: { content: "ancient" } }) + "\n",
      "utf-8",
    );

    const r = await query("fetch_session_events", [sid, agentPath]);
    expect(r.status).toBe(200);
    const lines = (r.json.result.data as string)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // 反扫从最新 shard 开始 → 读 events-2 (1 条)，没 boundary 继续 → 读 events-1
    // (含 boundary)，accumulator 含 boundary 了，stop → events-0 跳过。
    // 期望：events-1 全量 + events-2 全量 = 3 条，不含 "ancient"。
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.payload.content)).toEqual([
      "very-old",
      undefined,           // boundary 没 content 字段
      "after-compact",
    ]);
    expect(lines[1].type).toBe("compact_boundary");
  });

  test("fetch_session_events 大 payload (>64KB) → sentinel pass-through，不 reinflate", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    // 含非 base64 字符（"!"）→ detectEncoding 走 utf8 路径，便于下个 fetch_blob
    // 测试用 utf8 解码 round-trip。
    const huge = "y!".repeat(50_000); // 100_000 chars > LARGE_VALUE_THRESHOLD = 64KB
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: huge }, ts: 1_000,
    });

    const r = await query("fetch_session_events", [sid, agentPath]);
    expect(r.status).toBe(200);
    const lines = (r.json.result.data as string)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    const content = lines[0].payload.content;
    // sentinel —— 不是原 string；4 个字段 __ledger_blob__ + sha256 + enc + len
    expect(typeof content).toBe("object");
    expect(content.__ledger_blob__).toBe(true);
    expect(typeof content.sha256).toBe("string");
    expect(content.sha256).toMatch(/^[a-f0-9]{16}$/);
    expect(content.enc).toBe("utf8");
    expect(content.len).toBe(huge.length);
  });

  test("fetch_blob 拿回原始 bytes（utf8 enc round-trip）", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    // 同上：非 base64 字符触发 utf8 enc。raw bytes 长度等于 utf8 字节数（ascii
    // 1:1 = string.length）。
    const huge = "y!".repeat(40_000);
    await appendEvent(sid, agentPath, {
      source: "user", type: "user_input", to: agentPath, handoff: "turn",
      payload: { content: huge }, ts: 1_000,
    });

    // 先反查 sentinel 拿 sha256，再 fetch_blob
    const evRes = await query("fetch_session_events", [sid, agentPath]);
    const ev = JSON.parse((evRes.json.result.data as string).trim().split("\n")[0]);
    const sha256 = ev.payload.content.sha256;

    const r = await query("fetch_blob", [sid, agentPath, sha256]);
    expect(r.status).toBe(200);
    expect(r.json.result.ok).toBe(true);
    const blob = r.json.result.data;
    expect(blob.sha256).toBe(sha256);
    expect(blob.bytes).toBe(huge.length);
    // sentinel.enc=utf8 → base64 解码后等于原 utf8 string
    expect(Buffer.from(blob.data, "base64").toString("utf8")).toBe(huge);
  });

  test("fetch_blob 非法 sha256 (非 16hex) → ok:false", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    const r = await query("fetch_blob", [sid, agentPath, "not-a-hash"]);
    expect(r.status).toBe(500);
    expect(r.json.result.ok).toBe(false);
    expect(r.json.result.error).toContain("16-hex");
  });

  test("fetch_blob path-traversal: agentPath 含 .. → ok:false", async () => {
    const { sid } = await makeSidWithRootAgent();
    const r = await query("fetch_blob", [sid, "root/../../etc", "0123456789abcdef"]);
    expect(r.status).toBe(500);
    expect(r.json.result.ok).toBe(false);
    expect(r.json.result.error).toContain("safe relative path");
  });

  test("fetch_blob blob 不存在 → ok:false（错误信息不带绝对路径）", async () => {
    const { sid, agentPath } = await makeSidWithRootAgent();
    const r = await query("fetch_blob", [sid, agentPath, "deadbeefdeadbeef"]);
    expect(r.status).toBe(500);
    expect(r.json.result.ok).toBe(false);
    expect(r.json.result.error).toContain("not found");
    expect(r.json.result.error).not.toContain(userRoot);
  });
});

