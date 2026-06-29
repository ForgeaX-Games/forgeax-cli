/** GET /api/sessions ?game= scope (game↔session 绑定) — the session list is
 *  collapsed to a single game: `?game=<slug>` wins, absent falls back to the
 *  active game (active-game.json), and a game with no sessions returns []. The
 *  bound slug per session is the path-derived `defaultDir`
 *  (= basename(sessionWorkDir)).
 *
 *  Real PathManager + SessionManager + Hono router — no `mock.module` (it leaks
 *  process-globally across test files; see memory). A minimal per-sid
 *  SessionLayout binds two on-disk sessions to two different games. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { initPathManager, getPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import { createSessionsRouter } from "../src/api/sessions";
import type { SessionLayout } from "../src/fs/session-layout";

let tmp: string;
let prevProjectRoot: string | undefined;

// sid → bound game slug. sessionRoot lands the state tree (session.json) under
// <tmp>/state/<sid>; sessionWorkDir basename = the slug → that's the derived
// defaultDir the router filters on.
const BIND: Record<string, string> = { "s-alpha": "game-a", "s-beta": "game-b" };

function makeLayout(stateRoot: string, gamesRoot: string): SessionLayout {
  const slugOf = (sid: string) => BIND[sid] ?? "default";
  return {
    allocate: (sid) => ({ sessionRoot: join(stateRoot, sid), workDir: join(gamesRoot, slugOf(sid)) }),
    sessionRoot: (sid) => join(stateRoot, sid),
    sessionWorkDir: (sid) => join(gamesRoot, slugOf(sid)),
    listSessionIds: () => Object.keys(BIND),
  };
}

function appFetch(url: string) {
  const a = new Hono();
  a.route("/api/sessions", createSessionsRouter());
  return a.request(url);
}

async function listSids(url: string): Promise<string[]> {
  const res = await appFetch(url);
  expect(res.status).toBe(200);
  const j = (await res.json()) as { sessions: { sid: string; defaultDir?: string }[] };
  return j.sessions.map((s) => s.sid).sort();
}

beforeEach(async () => {
  tmp = mkdtempSync(resolve(tmpdir(), "forgeax-sgs-"));
  prevProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = tmp; // defaultProjectRoot() → getActiveGame root
  resetPathManager();
  await resetSessionManager();
  const stateRoot = join(tmp, "state");
  const gamesRoot = join(tmp, ".forgeax", "games");
  for (const [sid, slug] of Object.entries(BIND)) {
    mkdirSync(join(gamesRoot, slug), { recursive: true });
    mkdirSync(join(stateRoot, sid), { recursive: true });
    writeFileSync(
      join(stateRoot, sid, "session.json"),
      JSON.stringify({ version: 1, displayName: sid, autoStart: true }),
      "utf-8",
    );
  }
  initPathManager({ userRoot: join(tmp, "user"), layout: makeLayout(stateRoot, gamesRoot) });
  initSessionManager(getPathManager());
});

afterEach(async () => {
  resetPathManager();
  await resetSessionManager();
  if (prevProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = prevProjectRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/sessions game scope", () => {
  test("?game=<slug> returns only that game's sessions", async () => {
    expect(await listSids("/api/sessions?game=game-a")).toEqual(["s-alpha"]);
    expect(await listSids("/api/sessions?game=game-b")).toEqual(["s-beta"]);
  });

  test("no ?game= falls back to the active game (active-game.json)", async () => {
    const { setActiveGame } = await import("../src/api/lib/active-game");
    setActiveGame(tmp, "game-b");
    expect(await listSids("/api/sessions")).toEqual(["s-beta"]);
  });

  test("?game= for a game with no sessions returns []", async () => {
    mkdirSync(join(tmp, ".forgeax", "games", "game-empty"), { recursive: true });
    expect(await listSids("/api/sessions?game=game-empty")).toEqual([]);
  });
});
