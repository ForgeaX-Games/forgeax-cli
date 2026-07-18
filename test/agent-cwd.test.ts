/** agent.cwd ← injected SessionLayout.sessionWorkDir (plan B PR2).
 *
 *  Pre-PR2 the agent cwd was resolved from a stored `defaultDir` slug via
 *  `pm.user().gameDir(slug)`. PR2 removes that: the cwd is now whatever the
 *  injected SessionLayout reports as `sessionWorkDir(sid)` (studio = the bound
 *  game dir). These tests lock the new seam + its graceful-degradation contract:
 *    (a) workDir exists           → ctx.cwd === sessionWorkDir
 *    (b) workDir missing          → ctx.cwd falls back to agentDir (no throw)
 *    (c) fs.resolve('.') === cwd  (fallback chain)
 *    (e) sessionWorkDir throws    → ctx.cwd falls back to agentDir (no throw out of attach)
 *    (g) cwd is a non-empty absolute string
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import { FlatSessionLayout, type SessionLayout } from "../src/fs/session-layout";
import type { Session } from "../src/core/session";

let projectRoot: string;
let sessionsRoot: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-cwd-"));
  sessionsRoot = join(projectRoot, "sessions");
  resetPathManager();
  await resetSessionManager();
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** init pm with the given layout, create + scaffold a root agent + reopen. */
async function bootSession(layout: SessionLayout): Promise<{ session: Session; sid: string }> {
  initPathManager({ projectRoot, layout });
  const pm = getPathManager();
  const sm = initSessionManager(pm);
  const initial = await sm.create({ displayName: "t" });
  const sid = initial.sid;
  await sm.close(sid);
  const agentRoot = pm.session(sid).agent("root");
  mkdirSync(agentRoot.root(), { recursive: true });
  writeFileSync(agentRoot.agentJson(), "{}\n", "utf-8");
  const session = await sm.open(sid);
  return { session, sid };
}

describe("agentContext.cwd ← layout.sessionWorkDir (normal)", () => {
  test("(a) workDir exists → ctx.cwd === sessionWorkDir", async () => {
    const workDir = join(projectRoot, ".forgeax", "games", "test-game");
    mkdirSync(workDir, { recursive: true });
    const { session, sid } = await bootSession(new FlatSessionLayout(sessionsRoot, workDir));
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();
    expect(agent!.agentContext.cwd).toBe(workDir);
    await getSessionManagerClose(sid);
  });

  test("(c) fs.resolve('.') === ctx.cwd (fallback chain)", async () => {
    const workDir = join(projectRoot, ".forgeax", "games", "chain");
    mkdirSync(workDir, { recursive: true });
    const { session, sid } = await bootSession(new FlatSessionLayout(sessionsRoot, workDir));
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent!.agentContext.fs.resolve(".")).toBe(agent!.agentContext.cwd);
    await getSessionManagerClose(sid);
  });

  test("(g) ctx.cwd is a non-empty absolute string", async () => {
    const workDir = join(projectRoot, ".forgeax", "games", "diag");
    mkdirSync(workDir, { recursive: true });
    const { session, sid } = await bootSession(new FlatSessionLayout(sessionsRoot, workDir));
    await session.scheduler.attachAgent("root");
    const cwd = session.scheduler.getAgent("root")!.agentContext.cwd;
    expect(typeof cwd).toBe("string");
    expect(cwd.length).toBeGreaterThan(0);
    expect(cwd.startsWith("/")).toBe(true);
    await getSessionManagerClose(sid);
  });
});

describe("agentContext.cwd ← layout.sessionWorkDir (graceful fallback, no throw)", () => {
  test("(b) workDir missing → ctx.cwd falls back to agentDir", async () => {
    const ghost = join(projectRoot, ".forgeax", "games", "ghost"); // never created
    const { session, sid } = await bootSession(new FlatSessionLayout(sessionsRoot, ghost));
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();
    expect(agent!.agentContext.cwd).toBe(getPathManager().session(sid).agent("root").root());
    await getSessionManagerClose(sid);
  });

  test("(e) sessionWorkDir throws → ctx.cwd falls back to agentDir (no throw out of attach)", async () => {
    const throwing: SessionLayout = {
      allocate(s) {
        const r = join(sessionsRoot, s);
        mkdirSync(r, { recursive: true });
        return { sessionRoot: r, workDir: "" };
      },
      sessionRoot(s) { return join(sessionsRoot, s); },
      sessionWorkDir() { throw new Error("boom: invalid binding"); },
      listSessionIds() { return []; },
    };
    const { session, sid } = await bootSession(throwing);
    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();
    expect(agent!.agentContext.cwd).toBe(getPathManager().session(sid).agent("root").root());
    await getSessionManagerClose(sid);
  });
});

async function getSessionManagerClose(sid: string): Promise<void> {
  const { getSessionManager } = await import("../src/core/session-manager");
  await getSessionManager().close(sid);
}
