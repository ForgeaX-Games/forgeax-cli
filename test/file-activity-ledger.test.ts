/** End-to-end test for the per-session file-activity ledger.
 *
 *  Wires:
 *    initPathManager → initSessionManager → sm.create → scaffold root agent →
 *    sm.open → scheduler.attachAgent → call agentContext.fs.writeText →
 *    assert ledger has the record + emit fired + lock released.
 *
 *  Mirrors agent-cwd.test.ts harness so any new fs / agent-init plumbing
 *  is exercised through the same path real /api/sessions traffic uses. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";
import type { Event } from "../src/core/types";

let projectRoot: string;
let prevProjectRootEnv: string | undefined;

beforeEach(async () => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-fileact-"));
  prevProjectRootEnv = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  await resetSessionManager();
  initPathManager({ projectRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  if (prevProjectRootEnv === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = prevProjectRootEnv;
  rmSync(projectRoot, { recursive: true, force: true });
});

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

describe("file-activity ledger", () => {
  test("writeText appends a record and clears the lock", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-1");

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    expect(agent).not.toBeNull();

    const fs = agent!.agentContext.fs;
    const target = "src/foo.ts";
    await fs.writeText(target, "export const x = 1;\n");

    // ledger file exists at session root, not agent root
    const ledgerPath = pm.session(session.sid).fileActivityLog();
    expect(existsSync(ledgerPath)).toBe(true);

    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.agentPath).toBe("root");
    expect(rec.op).toBe("write");
    expect(rec.isCreate).toBe(true);
    expect(typeof rec.path).toBe("string");
    expect((rec.path as string).endsWith("/.forgeax/games/fileact-1/src/foo.ts")).toBe(true);
    expect(rec.bytes).toBe("export const x = 1;\n".length);

    // lock should be released after the write returns
    expect(session.fileLocks.size).toBe(0);

    // queryable via ledger.query
    const records = session.fileActivity.query({ limit: 10 });
    expect(records.length).toBe(1);
    expect(records[0]!.agentPath).toBe("root");

    await sm.close(session.sid);
  });

  test("subsequent write to same path is not a create", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-2");

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    const fs = agent!.agentContext.fs;
    await fs.writeText("a.txt", "first\n");
    await fs.writeText("a.txt", "second\n");

    const ledgerPath = pm.session(session.sid).fileActivityLog();
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    const r1 = JSON.parse(lines[0]!) as Record<string, unknown>;
    const r2 = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(r1.isCreate).toBe(true);
    expect(r2.isCreate).toBe(false);

    await sm.close(session.sid);
  });

  test("emits file-activity:done event on session bus, persistence skips it", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-3");

    const captured: Event[] = [];
    const unsub = session.eventBus.observe((event) => {
      if (event.type.startsWith("file-activity:")) captured.push(event);
    });

    await session.scheduler.attachAgent("root");
    const agent = session.scheduler.getAgent("root");
    await agent!.agentContext.fs.writeText("b.txt", "hi");

    const kinds = captured.map((e) => e.type);
    expect(kinds).toContain("file-activity:start");
    expect(kinds).toContain("file-activity:done");

    // file-activity:* events MUST NOT land in the per-agent EventLedger
    // (would pollute LLM history). Verify by reading the agent's ledger.
    const agentLedger = session.getOrCreateLedger("root");
    const all = await agentLedger.readAllEvents();
    const types = all.map((e: { type?: string }) => e.type);
    expect(types).not.toContain("file-activity:start");
    expect(types).not.toContain("file-activity:done");

    unsub();
    await sm.close(session.sid);
  });

  test("file_activity_recent slot renders ledger as a table", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-slot");

    await session.scheduler.attachAgent("root");
    const root = session.scheduler.getAgent("root")!;
    await root.agentContext.fs.writeText("hello.md", "# hi\n");
    await root.agentContext.fs.writeText("world.txt", "stuff");

    const slotFactory = (await import("../builtin/kits/agent_manage/slots/file_activity_recent")).default;
    const slot = slotFactory(root.agentContext);
    expect(slot.name).toBe("file_activity_recent");
    const content = typeof slot.content === "function" ? slot.content() : slot.content;
    expect(typeof content).toBe("string");
    const text = content as string;
    expect(text).toContain("Recent file activity");
    expect(text).toContain("hello.md");
    expect(text).toContain("world.txt");
    // The agent should be flagged as "you" since these are its own writes.
    expect(text).toContain("(you)");
    // create marker should appear (first writes are creates).
    expect(text).toContain("create");

    await sm.close(session.sid);
  });

  test("workbench /agents?sid= attributes files via ledger, not produces", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-wb");

    // Stand up a fake marketplace manifest at projectRoot so the workbench
    // endpoint has agents to enumerate. Two agents, both claiming the same
    // produces glob — under the legacy code path BOTH would be attributed
    // the same file. Under ledger-derived attribution only the actual writer
    // gets it.
    mkdirSync(join(projectRoot, "packages/marketplace"), { recursive: true });
    writeFileSync(
      join(projectRoot, "packages/marketplace/manifest.json"),
      JSON.stringify({
        agents: [
          { id: "root", role: "orchestrator", cardName: { zh: "Root" }, produces: ["**/*.ts"] },
          { id: "ghost", role: "design", cardName: { zh: "Ghost" }, produces: ["**/*.ts"] },
        ],
      }),
      "utf-8",
    );

    await session.scheduler.attachAgent("root");
    const root = session.scheduler.getAgent("root")!;
    await root.agentContext.fs.writeText("only-mine.ts", "export {};\n");

    const { createWorkbenchRouter } = await import("../src/api/workbench");
    const router = createWorkbenchRouter();
    const res = await router.fetch(
      new Request(`http://t/agents?lang=zh&include=files&sid=${encodeURIComponent(session.sid)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string; files: Array<{ name: string }> }> };
    const rootEntry = body.agents.find((a) => a.id === "root");
    const ghostEntry = body.agents.find((a) => a.id === "ghost");
    expect(rootEntry).toBeDefined();
    expect(ghostEntry).toBeDefined();
    // Root wrote one file; ghost wrote nothing → ghost.files MUST be empty
    // even though both have the same produces[]. That's the bug fix.
    expect(rootEntry!.files.some((f) => f.name === "only-mine.ts")).toBe(true);
    expect(ghostEntry!.files.length).toBe(0);

    await sm.close(session.sid);
  });

  test("apply_patch tags ledger op as 'patch', not 'write'", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-patch");

    await session.scheduler.attachAgent("root");
    const root = session.scheduler.getAgent("root")!;
    // Seed a file via the regular write path → op="write" + isCreate=true.
    await root.agentContext.fs.writeText("seed.txt", "alpha\nbeta\n");

    // Now apply a patch via the recorder's escape hatch (mirrors what
    // apply_patch.ts does when wrapped). recordedWrite emits op="patch".
    const fs = root.agentContext.fs as {
      recordedWrite?: (p: string, c: string, op: "patch") => Promise<void>;
    };
    expect(typeof fs.recordedWrite).toBe("function");
    await fs.recordedWrite!(root.agentContext.fs.resolve("seed.txt"), "alpha\nbeta\ngamma\n", "patch");

    const all = session.fileActivity.query({ limit: 10 });
    expect(all.length).toBe(2);
    // Newest-first: [0] is the patch, [1] is the original write.
    const ops = all.map((r) => r.op);
    expect(ops).toContain("patch");
    expect(ops).toContain("write");
    const patchRec = all.find((r) => r.op === "patch")!;
    expect(patchRec.isCreate).toBe(false);
    expect(patchRec.bytes).toBe("alpha\nbeta\ngamma\n".length);

    await sm.close(session.sid);
  });

  test("query filters by agent + path", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithGame(sm, "fileact-4");

    await session.scheduler.attachAgent("root");
    const root = session.scheduler.getAgent("root");
    await root!.agentContext.fs.writeText("x.txt", "x");
    await root!.agentContext.fs.writeText("y.txt", "y");

    const all = session.fileActivity.query({ limit: 10 });
    expect(all.length).toBe(2);

    const agentFiltered = session.fileActivity.query({ agent: "root" });
    expect(agentFiltered.length).toBe(2);

    const noMatch = session.fileActivity.query({ agent: "nobody" });
    expect(noMatch.length).toBe(0);

    const xOnly = session.fileActivity.query({ path: all.find((r) => r.path.endsWith("x.txt"))!.path });
    expect(xOnly.length).toBe(1);

    await sm.close(session.sid);
  });
});
