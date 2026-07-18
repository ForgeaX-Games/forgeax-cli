/** SessionLayout seam (plan B PR1) — verifies:
 *   - FlatSessionLayout path math + traversal guard + enumeration.
 *   - PathManager.session()/listSessionIds() route through the active layout.
 *   - Default (no layout injected) reproduces pre-seam home behavior, so a
 *     standalone game-agnostic cli is unchanged.
 *   - Injected studio-style (project-local) layout relocates the WHOLE session
 *     tree, and the split-collapse invariant holds: a session's logsDir() lands
 *     at <projectRoot>/.forgeax/sessions/<sid>/logs. The server's telemetrySink
 *     resolves trace/log via this same PathManager layout (getPathManager()
 *     .session(sid).logsDir()), so WAL and observability share one root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { FlatSessionLayout, listSessionDirs } from "../src/fs/session-layout";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "forgeax-sl-"));
  resetPathManager();
});

afterEach(() => {
  resetPathManager();
  rmSync(tmp, { recursive: true, force: true });
});

describe("FlatSessionLayout", () => {
  test("sessionRoot joins sid under the configured root", () => {
    const root = join(tmp, "sessions");
    const layout = new FlatSessionLayout(root, join(tmp, "work"));
    expect(layout.sessionRoot("abc")).toBe(join(root, "abc"));
  });

  test("sessionRoot rejects traversal segments (security guard)", () => {
    const layout = new FlatSessionLayout(join(tmp, "sessions"), join(tmp, "work"));
    expect(() => layout.sessionRoot("../escape")).toThrow("PathManager: unsafe path segment");
    expect(() => layout.sessionRoot("..")).toThrow("PathManager: unsafe path segment");
    expect(() => layout.sessionRoot("")).toThrow("PathManager: unsafe path segment");
  });

  test("listSessionIds returns child dir names; empty when root absent", () => {
    const root = join(tmp, "sessions");
    expect(listSessionDirs(root)).toEqual([]); // absent → []
    mkdirSync(join(root, "s1"), { recursive: true });
    mkdirSync(join(root, "s2"), { recursive: true });
    const ids = new FlatSessionLayout(root, join(tmp, "work")).listSessionIds().sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  test("allocate creates the session dir + returns roots; sessionWorkDir is fixed", () => {
    const root = join(tmp, "sessions");
    const workDir = join(tmp, "work");
    const layout = new FlatSessionLayout(root, workDir);
    const { sessionRoot, workDir: wd } = layout.allocate("sX");
    expect(sessionRoot).toBe(join(root, "sX"));
    expect(wd).toBe(workDir);
    expect(layout.sessionWorkDir("sX")).toBe(workDir);
    expect(layout.sessionWorkDir("anyOther")).toBe(workDir); // generic: same workDir for all
    expect(listSessionDirs(root)).toEqual(["sX"]); // allocate made the dir
  });
});

describe("PathManager default layout (no injection) — home, behavior-preserving", () => {
  test("session root stays at <userRoot>/sessions/<sid>", () => {
    const userRoot = join(tmp, "home");
    initPathManager({ userRoot, projectRoot: join(tmp, "proj") });
    const pm = getPathManager();
    expect(pm.session("sid-1").root()).toBe(join(userRoot, "sessions", "sid-1"));
  });

  test("listSessionIds scans <userRoot>/sessions", () => {
    const userRoot = join(tmp, "home");
    mkdirSync(join(userRoot, "sessions", "a"), { recursive: true });
    mkdirSync(join(userRoot, "sessions", "b"), { recursive: true });
    initPathManager({ userRoot, projectRoot: join(tmp, "proj") });
    expect(getPathManager().listSessionIds().sort()).toEqual(["a", "b"]);
  });
});

describe("PathManager with injected studio-style layout — project-local + split collapse", () => {
  test("session tree (root + logs + config) relocates under projectRoot/.forgeax/sessions", () => {
    const projectRoot = join(tmp, "ws");
    const sessionsRoot = resolve(projectRoot, ".forgeax", "sessions");
    initPathManager({
      userRoot: join(tmp, "home"),
      projectRoot,
      layout: new FlatSessionLayout(sessionsRoot, projectRoot),
    });
    const pm = getPathManager();
    const sid = "7c02a7d8";

    // WAL root is now project-local.
    expect(pm.session(sid).root()).toBe(join(sessionsRoot, sid));
    expect(pm.session(sid).configFile()).toBe(join(sessionsRoot, sid, "session.json"));

    // Split-collapse invariant: logsDir() == <projectRoot>/.forgeax/sessions/<sid>/logs,
    // i.e. exactly where the server's telemetrySink writes trace/log.jsonl (it
    // resolves via this same getPathManager().session(sid).logsDir()).
    const expectedLogs = resolve(projectRoot, ".forgeax", "sessions", sid, "logs");
    expect(pm.session(sid).logsDir()).toBe(expectedLogs);
  });

  test("listSessionIds enumerates the project-local sessions, not home", () => {
    const projectRoot = join(tmp, "ws");
    const sessionsRoot = resolve(projectRoot, ".forgeax", "sessions");
    mkdirSync(join(sessionsRoot, "proj-only"), { recursive: true });
    mkdirSync(join(tmp, "home", "sessions", "home-only"), { recursive: true });
    initPathManager({
      userRoot: join(tmp, "home"),
      projectRoot,
      layout: new FlatSessionLayout(sessionsRoot, projectRoot),
    });
    expect(getPathManager().listSessionIds()).toEqual(["proj-only"]);
  });
});
