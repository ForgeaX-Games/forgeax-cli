import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Event } from "../src/core/types";
import type { Session } from "../src/core/session";

// Plan §9 烟雾测试：create → publish → ledger 落盘 → close → open → replay.
// 本轮 kits / tools / directives / model 全没接，没法跑真正的 LLM 回路；
// 但 Session 的 EventBus → 每 agent ledger 持久化是 plumbing 层最关键的口子，
// 必须在再叠加任何东西前就被锁住。

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-e2e-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/** Create a session, then close it, scaffold a root agent.json on disk, and
 *  re-open. Re-open triggers AgentTree.init() → _scanInitial which sees the
 *  agent.json synchronously — no reliance on chokidar event delivery. */
async function createSessionWithRoot(
  sm: ReturnType<typeof initSessionManager>,
  opts: { displayName: string; defaultDir: string },
): Promise<Session> {
  // Bug-20260522: agent factory resolves defaultDir slug to an absolute
  // game root via pm.user().gameDir(slug) and checks existsSync. Pre-create
  // the game directory so the e2e agent spawn does not hit GAME_NOT_FOUND.
  const pm = getPathManager();
  const gameDir = pm.user().gameDir(opts.defaultDir);
  mkdirSync(gameDir, { recursive: true });

  const initial = await sm.create(opts);
  const sid = initial.sid;
  await sm.close(sid);
  const layer = pm.session(sid).agent("root");
  mkdirSync(layer.root(), { recursive: true });
  writeFileSync(layer.agentJson(), "{}\n", "utf-8");
  return sm.open(sid);
}

describe("Session E2E — bus → ledger → reopen → replay", () => {
  test("user_input emitted on bus 落到 root agent ledger，关掉 session 再 open 还能 replay 出来", async () => {
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);

    const session = await createSessionWithRoot(sm, {
      displayName: "smoke",
      defaultDir: "smoke-game",
    });

    // 直接通过 bus 模拟「用户喂一句话给 root」—— 这条 routed event
    // 应该被 _bindLedgerPersistence 捕到，并落到 root 的 ledger 里。
    const userEvent: Event = {
      source: "user",
      type: "user_input",
      payload: { content: "hello" },
      to: "root",
      handoff: "turn",
      ts: Date.now(),
    };
    session.eventBus.emit(userEvent);

    // 持久化 deferred 到 microtask；等一拍。
    await flushMicrotasks();

    // 关 session（不删盘）。
    await sm.close(session.sid);

    // 重新 open —— 不应触发 LLM，只 hydrate 内存态。
    const reopened = await sm.open(session.sid);
    expect(reopened.sid).toBe(session.sid);

    const ledger = reopened.getOrCreateLedger("root");
    const events = await ledger.readAllEvents();

    const userInputs = events.filter((e) => e.type === "user_input");
    expect(userInputs.length).toBe(1);
    const first = userInputs[0];
    if (!first) throw new Error("unreachable");
    expect(first.payload?.content).toBe("hello");

    await sm.close(reopened.sid);
  });

  test("stream:* 事件不落 ledger（per ref _bindEventBus 行为）", async () => {
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "no-stream", defaultDir: "x" });

    session.eventBus.emit({
      source: "agent:root",
      type: "stream:assistant_chunk",
      payload: { content: "abc" },
      to: "root",
      ts: Date.now(),
    });
    // 也喂一条非 stream 事件作 sentinel，确认 observer 在跑。
    session.eventBus.emit({
      source: "agent:root",
      type: "assistant_response",
      payload: { content: "done" },
      to: "root",
      ts: Date.now(),
    });
    await flushMicrotasks();

    const events = await session.getOrCreateLedger("root").readAllEvents();
    expect(events.some((e) => e.type === "assistant_response")).toBe(true);
    expect(events.some((e) => e.type.startsWith("stream:"))).toBe(false);

    await sm.close(session.sid);
  });

  test("裸 mkdir <sid>/agents/<path>/ → AgentTree 立刻识别该目录为 agent 节点（无需 agent.json）", async () => {
    // 设计前提（用户 2026-05-20 钉死）：**目录就是事实**。AgentTree 用纯
    // readdirSync 扫盘，不依赖 chokidar，也不要求 agent.json 存在。SessionManager
    // 在 attach 该 agent 时 _readAgentJson 拿到缺失的 agent.json 会用
    // AGENT_DEFAULTS 兜底，逻辑等价于"自动 scaffold conscious"。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "scaffold", defaultDir: "x" });

    const ioriDir = pm.session(session.sid).agent("root/agents/iori").root();
    mkdirSync(ioriDir, { recursive: true });

    // 同步 readdir，立即可见。display = "iori"，depth = 3（root, agents, iori）。
    const node = session.tree.get("root/agents/iori");
    expect(node).toBeDefined();
    expect(node?.display).toBe("iori");
    expect(node?.depth).toBe(3);

    // tree.list() 包括 root + iori 两个节点。
    const list = session.tree.list().map((n) => n.path).sort();
    expect(list).toEqual(["root", "root/agents/iori"]);

    await sm.close(session.sid);
  });

  test("kits 子系统接通 BaseAgent：agent-local kits/<kit>/tools/<file>.ts → toolRegistry 出 tool", async () => {
    // B1.1-B1.9 烟雾：base-loader 真扫盘 + tool-loader createInstance + BaseAgent
    // .initKits + ConsciousAgent 默认 getTools = this.toolRegistry.list()。
    // builtin / user / session 三层留空，只塞 agent-local 一份 echo tool —— visibility
    // 走 "layer === agent → 永远 visible" 分支，不依赖 kits.user/session 开关。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "kit", defaultDir: "x" });

    // Drop a valid tool kit under root agent's `kits/demo/tools/echo.ts`.
    const rootLayer = pm.session(session.sid).agent("root");
    const echoToolPath = join(rootLayer.resourceDir("kits"), "demo", "tools", "echo.ts");
    mkdirSync(join(rootLayer.resourceDir("kits"), "demo", "tools"), { recursive: true });
    writeFileSync(
      echoToolPath,
      `export default {
        description: "echo input verbatim",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
        async execute(args) { return String(args.text ?? ""); },
      };\n`,
      "utf-8",
    );

    // Trigger attachAgent — which calls initKits internally now.
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();
    const tools = agent!.agentContext.tools.list();
    expect(tools.length).toBeGreaterThan(0);
    // tool name is qualified: "demo/tools/echo" (LLM-side mapping to bare
    // happens in ConsciousAgent.process loop, not in registry).
    const echo = tools.find((t) => t.name === "demo/tools/echo");
    expect(echo).toBeDefined();
    expect(typeof echo!.execute).toBe("function");

    await sm.close(session.sid);
  });

  test("kits 热更新 polling 路径（flushReloads）：attach 前就已存在 → 改内容 → registry 看到新版本", async () => {
    // 对齐 ref 设计：flushReloads 的 prev=undefined 只设 baseline 不触发，
    // 真正承载 ADD 路径的是 fs.watch（下一个 test）。polling 的本职是兜
    // **MODIFY** —— 当 fs.watch 在 O_TRUNC+write+close 之类模式上漏 event
    // 时让 ConsciousAgent 在 tool batch 之后能可靠拉到新内容。
    //
    // 因此先把 tool 文件落盘，再 attach（让 initKits 时直接走 _loadInternal
    // 把 v1 装进 registry），之后改内容再 flushReloads 验证 polling 出新版本。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "hot1", defaultDir: "x" });

    const rootLayer = pm.session(session.sid).agent("root");
    const kitToolsDir = join(rootLayer.resourceDir("kits"), "hot", "tools");
    mkdirSync(kitToolsDir, { recursive: true });
    const toolPath = join(kitToolsDir, "ping.ts");
    writeFileSync(
      toolPath,
      `export default {
        description: "v1",
        input_schema: { type: "object", properties: {} },
        async execute() { return "pong-v1"; },
      };\n`,
      "utf-8",
    );

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root")!;
    const v1 = agent.agentContext.tools.list().find((t) => t.name === "hot/tools/ping");
    expect(v1).toBeDefined();
    expect(v1!.description).toBe("v1");

    const baselineTriggered = await session.kitReloadCoordinator.flushReloads();
    expect(baselineTriggered).toBe(false);

    writeFileSync(
      toolPath,
      `export default {
        description: "v2",
        input_schema: { type: "object", properties: {} },
        async execute() { return "pong-v2"; },
      };\n`,
      "utf-8",
    );
    const triggered = await session.kitReloadCoordinator.flushReloads();
    expect(triggered).toBe(true);
    const v2 = agent.agentContext.tools.list().find((t) => t.name === "hot/tools/ping");
    expect(v2).toBeDefined();
    expect(v2!.description).toBe("v2");

    expect(await session.kitReloadCoordinator.flushReloads()).toBe(false);

    await sm.close(session.sid);
  });

  test("logger 系统：ref 全量恢复（console bridge + per-Session 落盘 + ALS tag）", async () => {
    // A4 烟雾，对齐 agenteam-os-ref：
    //   1. SessionManager 构造 → setGlobalLogger（router 的 fallback 槽位）+
    //      attachConsoleEventEmitter（dispatcher 路由到 agent inbox）；
    //      sid 缺失时 console.* 落 <userRoot>/debug.log
    //   2. Session 构造 → <sid>/logs/{debug,latest}.log 文件存在，业务代码
    //      主动调 session.logger.* 直写
    //   3. ALS scope：`runWithAgentScope("root", () => console.warn(...))`
    //      触发的行 tag 是 `[root]`，不是 `[system]`
    //   4. INFO+ 同步落 latest.log
    //   5. SessionManager.shutdown() 反注册 router + close 全部 logger 后
    //      流稳定（dispose 不丢最后一行）
    //
    // sid 路由（用户钉死，2026-05-20）的核心不变量在下一个 test "logger 路由：..." 锁。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const { runWithAgentScope } = await import("../src/core/logger");
    const sm = initSessionManager(pm);
    expect(sm.logger).toBeDefined();

    const session = await createSessionWithRoot(sm, { displayName: "log", defaultDir: "x" });
    const layer = pm.session(session.sid);

    // 业务代码直接调 session.logger.info（plumbing / scheduler 路径）
    session.logger.info("root", undefined, "session-up");

    // console.* 进 SM.logger（user-level）；ALS 包过 → tag 带 agentId
    runWithAgentScope("root", () => {
      console.warn("boot warning from root");
    });
    // 无 ALS scope → tag fallback 到 "system"（DEFAULT_LOG_CONTEXT）
    console.log("plain log no scope");

    await sm.logger.flush();
    await session.logger.flush();

    expect(existsSync(pm.user().debugLogFile())).toBe(true);
    expect(existsSync(layer.debugLogFile())).toBe(true);
    expect(existsSync(layer.latestLogFile())).toBe(true);

    // 关 session（per-Session logger close）—— SM 单例 + console bridge 仍活
    await sm.close(session.sid);

    const userDebug = readFileSync(pm.user().debugLogFile(), "utf-8");
    expect(userDebug).toContain("boot warning from root");
    expect(userDebug).toContain("[root]");          // ALS 拿到 agentId
    expect(userDebug).toContain("plain log no scope");
    expect(userDebug).toContain("[system]");        // 无 scope fallback

    const debugLog = readFileSync(layer.debugLogFile(), "utf-8");
    const latestLog = readFileSync(layer.latestLogFile(), "utf-8");
    expect(debugLog).toContain("session-up");
    expect(debugLog).toContain("[root]");
    expect(latestLog).toContain("session-up");      // INFO+ 双写
  });

  test("logger 路由：console.* 按 ALS sid 分流到 session / global", async () => {
    // 核心不变量（2026-05-20 钉死）：
    //   - runWithSession(sid) 内 console.* → 只进 <sid>/logs/{debug,latest}.log
    //   - 无 sid scope 的 console.* → 只进 <userRoot>/debug.log
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const { runWithSession } = await import("../src/core/logger");
    const sm = initSessionManager(pm);
    const s = await sm.create({ displayName: "R", defaultDir: "r-game" });

    runWithSession(s.sid, () => console.warn("from-session"));
    console.log("from-global");

    // sm.close 触发 stream.end() —— 让 lazy WriteStream 落盘后再读。
    await sm.close(s.sid);

    const user = readFileSync(pm.user().debugLogFile(), "utf-8");
    const session = readFileSync(pm.session(s.sid).debugLogFile(), "utf-8");

    expect(session).toContain("from-session");
    expect(session).not.toContain("from-global");
    expect(user).toContain("from-global");
    expect(user).not.toContain("from-session");
  });

  test("LRU 纯末位淘汰：超出 maxSessions 即软 close 最旧 sid", async () => {
    // Session 不再持 client attach 计数，LRU 决策完全按位次。被踢的 sid 在下一次
    // open() 时会从盘上 hydrate 回来（变成一个新的内存实例）。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm, { maxSessions: 1 });

    const a = await sm.create({ displayName: "a", defaultDir: "a" });
    const aSid = a.sid;
    // 即使有 cli 在订阅 eventBus，也不影响淘汰决策 —— 订阅状态由外层（如 WsHub）自管。
    const unsubscribe = a.eventBus.observe(() => {});

    await sm.create({ displayName: "b", defaultDir: "b" });

    // a 已经被 LRU 软 close；reopen 会从盘 hydrate 出新实例
    const aReopen = await sm.open(aSid);
    expect(aReopen).not.toBe(a);
    expect(aReopen.sid).toBe(aSid);

    unsubscribe();
    await sm.close(aSid);
  });

  test("AC-02 full-chain cwd: session.json defaultDir → game dir exists → agent boots → ctx.cwd === game absolute path", async () => {
    // Create a session bound to 'test-game' defaultDir. The helper
    // createSessionWithRoot calls sm.create -> sm.close -> sm.open which
    // triggers attachAgent internally. After attach, agentContext.cwd must
    // equal pm.user().gameDir('test-game') via realpath normalization.
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);

    const session = await createSessionWithRoot(sm, {
      displayName: "cwd-test",
      defaultDir: "test-game",
    });

    // attachAgent builds a FreshBaseAgent via the agentFactory injected by
    // _buildSession — that factory resolves session.config.defaultDir into
    // sessionCwd and passes it to the agent constructor.
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const expected = pm.user().gameDir("test-game");
    const ctx = agent!.agentContext;

    // AC-02: agentContext.cwd IS the resolved game root absolute path.
    expect(ctx.cwd).toBe(expected);

    // AC-03 / AC-04 (fs-bridge view): fs.resolve('.') === cwd.
    const resolved = ctx.fs.resolve(".");
    expect(resolved).toBe(ctx.cwd);

    await sm.close(session.sid);
  });
});
