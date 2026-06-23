/** M2 w10 — Integration tests for agent.cwd + fallback chain + error paths.
 *
 *  Verifies:
 *    (a) defaultDir with existing game → agentContext.cwd === pm.user().gameDir(slug)
 *    (b) defaultDir empty → agentContext.cwd === agentDir (graceful degradation)
 *    (c) sessionCwd passed → fs.resolve('.') === sessionCwd (fallback chain)
 *    (d) nonexistent slug → no throw, graceful fallback to agentDir
 *    (e) invalid slug → no throw, graceful fallback to agentDir
 *    (f) defaultDir undefined → agent normal construction, no error
 *    (g) agentContext.cwd is string and readable (AC-05 diagnostic interface)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-cwd-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ projectRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Create a game directory tree under .forgeax/games/<slug>, write a minimal
 *  forge.json, then create a session bound to that slug, close it, scaffold a
 *  root agent.json, and re-open. Returns the open session. */
async function createSessionWithGame(
  sm: ReturnType<typeof initSessionManager>,
  slug: string,
): Promise<Session> {
  const pm = getPathManager();
  const gameDir = pm.user().gameDir(slug);
  mkdirSync(gameDir, { recursive: true });
  writeFileSync(join(gameDir, "forge.json"), "{}\n", "utf-8");

  const initial = await sm.create({ displayName: slug, defaultDir: slug });
  const sid = initial.sid;
  await sm.close(sid);
  const agentRoot = pm.session(sid).agent("root");
  mkdirSync(agentRoot.root(), { recursive: true });
  writeFileSync(agentRoot.agentJson(), "{}\n", "utf-8");
  return sm.open(sid);
}

/** Create a session *without* a pre-existing game directory, with an explicit
 *  defaultDir value. Used for error-path tests. */
async function createSessionWithoutGame(
  sm: ReturnType<typeof initSessionManager>,
  slug: string,
): Promise<Session> {
  const pm = getPathManager();
  const initial = await sm.create({ displayName: slug, defaultDir: slug });
  const sid = initial.sid;
  await sm.close(sid);
  const agentRoot = pm.session(sid).agent("root");
  mkdirSync(agentRoot.root(), { recursive: true });
  writeFileSync(agentRoot.agentJson(), "{}\n", "utf-8");
  return sm.open(sid);
}

describe("agentContext.cwd — normal path", () => {
  test("(a) defaultDir='test-game' with existing game dir → ctx.cwd === game path", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "test-game");

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const cwd = agent!.agentContext.cwd;
    const expected = pm.user().gameDir("test-game");
    // cwd should equal the instance-local game root (absolute, resolved).
    expect(cwd).toBe(expected);
    expect(cwd.endsWith("/.forgeax/games/test-game")).toBe(true);

    await sm.close(session.sid);
  });

  test("(b) defaultDir empty → ctx.cwd === agentDir (graceful degradation)", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);

    // defaultDir="" is falsy → agent factory skips game-dir resolution
    // entirely, leaving sessionCwd=undefined → base-agent falls back to
    // agentDir. No game directory exists on disk — this is the true
    // graceful-degradation path.
    const initial = await sm.create({ displayName: "no-dir", defaultDir: "" });
    const sid = initial.sid;
    await sm.close(sid);

    const agentRoot = pm.session(sid).agent("root");
    mkdirSync(agentRoot.root(), { recursive: true });
    writeFileSync(agentRoot.agentJson(), "{}\n", "utf-8");
    const session = await sm.open(sid);

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const cwd = agent!.agentContext.cwd;
    expect(cwd).toBe(agentRoot.root());

    await sm.close(session.sid);
  });

  test("(c) sessionCwd → fs.resolve('.') === sessionCwd (fallback chain)", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "chain-test");

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const fs = agent!.agentContext.fs;
    // fs.resolve with "." should yield the game dir (cwd), not the agent dir.
    const resolved = fs.resolve(".");
    const cwd = agent!.agentContext.cwd;
    expect(resolved).toBe(cwd);

    await sm.close(session.sid);
  });
});

// bug-20260522 (session-manager.ts agentFactory): a missing / invalid game
// slug must NOT throw out of attachAgent. Throwing there killed agentFactory
// before the ConsciousAgent ctor → no per-agent queue registered → user_input
// emits silently dropped → no turn ever ran. The resolver now logs a warn and
// falls back to agentDir (Graceful Degradation). These tests lock that contract
// (was: expecting a thrown GameDirResolutionError — that hard-fail is gone).
describe("agentContext.cwd — error paths (graceful fallback, no throw)", () => {
  test("(d) nonexistent slug → no throw, falls back to agentDir", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);

    const session = await createSessionWithoutGame(sm, "nosuchgame");

    // Must not throw — stale slug logs a warn and degrades to agentDir.
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const cwd = agent!.agentContext.cwd;
    expect(cwd).toBe(pm.session(session.sid).agent("root").root());

    await sm.close(session.sid);
  });

  test("(e) invalid slug '../escape' → no throw, falls back to agentDir", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);

    // safeSegment rejects '../escape' inside gameDir(); the resolver catches it,
    // warns, and falls back — it never throws GameDirResolutionError out of attach.
    const session = await createSessionWithoutGame(sm, "../escape");
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const cwd = agent!.agentContext.cwd;
    expect(cwd).toBe(pm.session(session.sid).agent("root").root());

    await sm.close(session.sid);
  });
});

describe("agentContext.cwd — edge cases", () => {
  test("(g) agentContext.cwd is string type and readable (AC-05 diagnostic)", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "diag-test");

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const cwd = agent!.agentContext.cwd;
    // Structural check: cwd is a non-empty string.
    expect(typeof cwd).toBe("string");
    expect(cwd.length).toBeGreaterThan(0);
    // It must be absolute.
    expect(cwd.startsWith("/")).toBe(true);
    // It should contain the slug as tail.
    expect(cwd.endsWith("diag-test")).toBe(true);

    await sm.close(session.sid);
  });
});