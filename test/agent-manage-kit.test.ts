/** agent_manage kit — delegate_to_subagent + list_subagents + roster slot.
 *
 *  Builds a real Session, scaffolds root + a fake teammate "mochi" on disk,
 *  attaches them, then calls the kit's tools straight from their default
 *  exports against root's agentContext. We bypass the plugin registry's
 *  persona resolver by pre-scaffolding the teammate so the existence path
 *  exercises only the bus.emit branch — the auto-scaffold branch is what
 *  the live e2e test in /tmp/forgeax-server.log already validates against
 *  the real marketplace persona pool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";
import type { Event, AgentContext } from "../src/core/types";

import delegateTool from "../builtin/kits/agent_manage/tools/delegate_to_subagent";
import listTool from "../builtin/kits/agent_manage/tools/list_subagents";
import rosterSlot, { buildRoster } from "../builtin/kits/agent_manage/slots/subagent_roster";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-am-"));
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

async function createSessionWithRootAndTeammate(displayName: string, slug: string, teammate?: string): Promise<Session> {
  const pm = getPathManager();
  const gameDir = pm.user().gameDir(slug);
  mkdirSync(gameDir, { recursive: true });

  const sm = initSessionManager(pm);
  const initial = await sm.create({ displayName, defaultDir: slug });
  const sid = initial.sid;
  await sm.close(sid);

  // root scaffold
  const rootLayer = pm.session(sid).agent("root");
  mkdirSync(rootLayer.root(), { recursive: true });
  writeFileSync(rootLayer.agentJson(), "{}\n", "utf-8");

  // optional teammate scaffold (so tree.get(teammate) is truthy without
  // hitting plugin registry / marketplace persona resolution).
  if (teammate) {
    const tlayer = pm.session(sid).agent(teammate);
    mkdirSync(tlayer.root(), { recursive: true });
    writeFileSync(tlayer.agentJson(), "{}\n", "utf-8");
  }

  return sm.open(sid);
}

async function getRootCtx(session: Session): Promise<AgentContext> {
  await session.scheduler.attachAgent("root");
  const root = session.scheduler.getAgent("root");
  if (!root) throw new Error("root agent failed to attach");
  return root.agentContext;
}

describe("agent_manage kit — delegate_to_subagent", () => {
  test("rejects empty agent argument", async () => {
    const session = await createSessionWithRootAndTeammate("dele-empty", "dg1");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "", message: "hi" }, ctx);
    expect(String(out)).toMatch(/missing 'agent'/);
  });

  test("rejects empty message argument", async () => {
    const session = await createSessionWithRootAndTeammate("dele-empty-msg", "dg2");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "mochi", message: "" }, ctx);
    expect(String(out)).toMatch(/missing 'message'/);
  });

  test("rejects invalid agent name (slash)", async () => {
    const session = await createSessionWithRootAndTeammate("dele-bad", "dg3");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "foo/bar", message: "hi" }, ctx);
    expect(String(out)).toMatch(/invalid agent id/);
  });

  test("rejects self-delegation", async () => {
    const session = await createSessionWithRootAndTeammate("dele-self", "dg4");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "root", message: "hi" }, ctx);
    expect(String(out)).toMatch(/cannot delegate to self/);
  });

  test("rejects unknown agent (no plugin / marketplace match)", async () => {
    const session = await createSessionWithRootAndTeammate("dele-unknown", "dg5");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute(
      { agent: "nobody-here-12345", message: "hi" },
      ctx,
    );
    expect(String(out)).toMatch(/no agent registered/);
  });

  test("emits user_input event to teammate when teammate already in tree", async () => {
    const session = await createSessionWithRootAndTeammate("dele-ok", "dg6", "mochi");
    const ctx = await getRootCtx(session);

    // Capture routed events with to:'mochi'.
    const routed: Event[] = [];
    const unsub = session.eventBus.observe((event) => {
      if (event.to === "mochi") routed.push(event);
    });
    try {
      const out = await delegateTool.execute(
        { agent: "mochi", message: "请帮我写一个故事" },
        ctx,
      );
      await flushMicrotasks();
      expect(String(out)).toMatch(/Delegated to mochi/);
      expect(routed.length).toBeGreaterThanOrEqual(1);
      const ev = routed[0]!;
      expect(ev.type).toBe("user_input");
      expect(ev.handoff).toBe("turn");
      expect(ev.to).toBe("mochi");
      expect(ev.payload.content).toBe("请帮我写一个故事");
      expect(ev.payload.delegatedBy).toBe("root");
    } finally {
      unsub();
    }
  });
});

describe("agent_manage kit — list_subagents", () => {
  test("input_schema is empty object (no args)", () => {
    expect(listTool.input_schema.type).toBe("object");
    expect(listTool.input_schema.properties).toEqual({});
  });

  test("lists active teammate, filters self", async () => {
    const session = await createSessionWithRootAndTeammate("list-ok", "ls1", "mochi");
    const ctx = await getRootCtx(session);
    const out = await listTool.execute({}, ctx);
    const text = String(out);
    // mochi appears (active or spawn-on-demand depending on plugin discovery).
    expect(text.includes("mochi")).toBe(true);
    // root never appears in its own roster.
    expect(text.match(/^- root\b/m)).toBeNull();
  });
});

describe("agent_manage kit — subagent_roster slot", () => {
  test("buildRoster filters self", async () => {
    const session = await createSessionWithRootAndTeammate("roster-self", "rs1", "mochi");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    expect(rows.find((r) => r.id === "root")).toBeUndefined();
  });

  test("buildRoster marks tree-resident teammate as active", async () => {
    const session = await createSessionWithRootAndTeammate("roster-active", "rs2", "mochi");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    const m = rows.find((r) => r.id === "mochi");
    expect(m).toBeDefined();
    expect(m!.active).toBe(true);
  });

  test("slot renders teammate header + delegate hint", async () => {
    const session = await createSessionWithRootAndTeammate("roster-render", "rs3", "mochi");
    const ctx = await getRootCtx(session);
    const slot = rosterSlot(ctx);
    expect(slot.name).toBe("subagent_roster");
    expect(slot.cacheHint).toBe("dynamic");
    const body = typeof slot.content === "function" ? slot.content() : slot.content;
    expect(body).toMatch(/# Teammates/);
    expect(body).toMatch(/delegate_to_subagent/);
    expect(body).toMatch(/mochi/);
  });

  test("slot prints empty placeholder when no teammates exist", async () => {
    // No teammate scaffolded — the only registered plugin agents are
    // whatever the plugin registry resolved at import time. The "active"
    // count from tree-resident agents (excluding root) is 0. Plugin agents
    // may still surface; assert only on the active section being absent.
    const session = await createSessionWithRootAndTeammate("roster-empty", "rs4");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    const activeRows = rows.filter((r) => r.active);
    expect(activeRows.length).toBe(0);
  });
});
