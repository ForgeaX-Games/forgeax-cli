/**
 * Regression — GET /api/workbench/games must tolerate a dangling symlink in
 * .forgeax/games/ and still enumerate every real game.
 *
 * Root cause (2026-06-23): a games/<slug> symlink whose target was removed by
 * a submodule sync (e.g. games/hellforge → packages/games/hellforge after the
 * games submodule no longer ships that game) makes statSync throw ENOENT.
 * listAllGames wrapped the whole readdir loop in ONE try/catch, so the first
 * bad entry truncated the list — every game read after it (including the
 * active game) silently vanished. The UI then couldn't find the active slug in
 * the list and fell back to games[0], previewing the WRONG game.
 *
 * The fix guards statSync per-entry (skip the bad link, keep enumerating). This
 * test locks that: all real games survive a dangling symlink, regardless of the
 * (uncontrollable) readdir order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { createWorkbenchRouter } from "../src/api/workbench";

let projectRoot: string;
let prevProjectRoot: string | undefined;
let app: Hono;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-games-dangling-"));
  // listAllGames/getActiveGame resolve via defaultProjectRoot() = env ?? cwd.
  prevProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  initPathManager({ projectRoot });
  app = new Hono();
  app.route("/api/workbench", createWorkbenchRouter());
});

afterEach(() => {
  resetPathManager();
  if (prevProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = prevProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeGame(slug: string): void {
  const dir = resolve(projectRoot, ".forgeax/games", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "forge.json"), JSON.stringify({ name: slug }), "utf-8");
}

describe("GET /api/workbench/games tolerates a dangling symlink", () => {
  test("every real game is enumerated; the dangling link is skipped", async () => {
    makeGame("alpha");
    makeGame("bravo");
    makeGame("charlie");
    // Broken link → packages/games/<x> that no longer exists.
    symlinkSync(
      resolve(projectRoot, "packages/games/gone"),
      resolve(projectRoot, ".forgeax/games", "gone"),
    );

    const res = await app.request("/api/workbench/games");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: Array<{ slug: string }> };
    const slugs = body.games.map((g) => g.slug).sort();
    expect(slugs).toEqual(["alpha", "bravo", "charlie"]);
  });
});
