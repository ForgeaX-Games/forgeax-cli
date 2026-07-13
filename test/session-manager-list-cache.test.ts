/** SessionManager.list() 缓存正确性 —— perf 修复(事件循环阻塞)的行为锁。
 *
 *  list() 对 closed session 的 config / lastActivityAt 走缓存(mtime 判新鲜 /
 *  close 失效),open session 读内存 SSOT + 每次现算。这些测试锁的是**缓存不改变
 *  可见行为**:盘上变更(config 改写、agents/ 新事件)必须在正确的失效点后被看见。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-smlist-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

describe("SessionManager.list() caches", () => {
  test("closed session: config 盘上改写(mtime 变)→ 下次 list 读到新 displayName", async () => {
    const sm = initSessionManager(getPathManager());
    const s = await sm.create({ displayName: "before" });
    const sid = s.sid;
    await sm.close(sid);

    expect(sm.list().find((e) => e.sid === sid)?.displayName).toBe("before");
    // 第二次 list 命中缓存,行为不变
    expect(sm.list().find((e) => e.sid === sid)?.displayName).toBe("before");

    // 盘上改写 config 并显式推 mtime(同毫秒写入时 mtime 不动 → 缓存判新鲜是
    // 预期语义,这里推 1s 模拟真实的"稍后编辑")
    const cf = getPathManager().session(sid).configFile();
    writeFileSync(cf, JSON.stringify({ displayName: "after", autoStart: true }) + "\n", "utf-8");
    const t = new Date(Date.now() + 1500);
    utimesSync(cf, t, t);

    expect(sm.list().find((e) => e.sid === sid)?.displayName).toBe("after");
  });

  test("closed session: lastActivityAt 缓存;open→写盘→close 后重算(close 失效点)", async () => {
    const sm = initSessionManager(getPathManager());
    const s = await sm.create({ displayName: "act" });
    const sid = s.sid;
    await sm.close(sid);

    const first = sm.list().find((e) => e.sid === sid)?.lastActivityAt;
    expect(first).toBeGreaterThan(0);

    // open 期间往 agents/ 写一个新文件(模拟 WAL 落盘),推后 mtime
    await sm.open(sid);
    const agentsDir = join(getPathManager().session(sid).root(), "agents", "forge", "events");
    mkdirSync(agentsDir, { recursive: true });
    const evFile = join(agentsDir, "events-1.jsonl");
    writeFileSync(evFile, "{}\n", "utf-8");
    const t = new Date(Date.now() + 5000);
    utimesSync(evFile, t, t);

    // open 状态下 list 每次现算 → 立即看到新活动时间
    const whileOpen = sm.list().find((e) => e.sid === sid)?.lastActivityAt;
    expect(whileOpen).toBeGreaterThan(first!);

    // close 失效缓存;closed 状态下第一次 list 重算并缓存同一值
    await sm.close(sid);
    const afterClose = sm.list().find((e) => e.sid === sid)?.lastActivityAt;
    expect(afterClose).toBe(whileOpen!);
  });

  test("open session: displayName 从内存 config 读(session.json 热改由 watcher 维护)", async () => {
    const sm = initSessionManager(getPathManager());
    const s = await sm.create({ displayName: "live" });
    // 直接改内存 config(watcher 路径的等价终态)——list 必须反映
    s.config = { ...s.config, displayName: "live-renamed" };
    expect(sm.list().find((e) => e.sid === s.sid)?.displayName).toBe("live-renamed");
    await sm.close(s.sid);
  });

  test("list({game}) 收口:不匹配的 session 不出现(与 route 过滤同语义)", async () => {
    const sm = initSessionManager(getPathManager());
    const a = await sm.create({ displayName: "a" });
    // FlatSessionLayout 下 defaultDir 派生自 workDir basename —— 全部同 slug;
    // 用一个不存在的 game 过滤应得到空集,证明过滤在 list 内生效。
    expect(sm.list({ game: "no-such-game" })).toEqual([]);
    expect(sm.list().some((e) => e.sid === a.sid)).toBe(true);
    await sm.close(a.sid);
  });
});
