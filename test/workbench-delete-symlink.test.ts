/**
 * w10 [test] — DELETE-symlink red test (three-state branch)
 *
 * Tests the DELETE /api/workbench/games/:slug endpoint for three cases:
 *   (a) symlink pointing to a directory — only the link is removed,
 *       target content survives
 *   (b) real directory — recursively deleted (current rm -rf behavior)
 *   (c) dangling symlink — the broken link is cleaned up
 *
 * RED phase: current workbench.ts DELETE handler (L257-271) uses
 * existsSync + rm(...) with no lstat/isSymbolicLink branch. While rm
 * does not follow symlinks in bun/Node, the code lacks an explicit
 * contract that *asserts* this safety (charter P3: explicit contract
 * over implicit side-effect). The test asserts the explicit-branch
 * behavior; it will fail if the impl does not handle dangling symlinks
 * (existsSync -> false -> 404) or if the assertions on symlink survival
 * are incomplete.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { createWorkbenchRouter } from "../src/api/workbench";

let projectRoot: string;
let app: Hono;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-delete-symlink-"));
  resetPathManager();
  initPathManager({ projectRoot });
  app = new Hono();
  app.route("/api/workbench", createWorkbenchRouter());
});

afterEach(() => {
  resetPathManager();
  rmSync(projectRoot, { recursive: true, force: true });
});

function gameDir(slug: string): string {
  return resolve(projectRoot, ".forgeax", "games", slug);
}

function ensureGamesDir(): string {
  const d = resolve(projectRoot, ".forgeax", "games");
  mkdirSync(d, { recursive: true });
  return d;
}

// ── (a) symlink pointing to a directory ─────────────────────────────────

describe("DELETE symlink to directory — link only removed, target survives", () => {
  test("target content intact after DELETE of symlink", async () => {
    const targetDir = resolve(projectRoot, "real-game-target");
    const targetSub = resolve(targetDir, "sub");
    const keeperPath = resolve(targetSub, "keep.txt");
    mkdirSync(targetSub, { recursive: true });
    writeFileSync(keeperPath, "precious data", "utf-8");

    const slug = "symlinked";
    ensureGamesDir();
    symlinkSync(targetSub, gameDir(slug), "dir");

    // Verify setup: gameDir is a symlink, target exists
    expect(lstatSync(gameDir(slug)).isSymbolicLink()).toBe(true);
    // realpathSync resolves /tmp -> /private/tmp on macOS, so use it on
    // both sides for a normalised comparison
    expect(realpathSync(gameDir(slug))).toBe(realpathSync(targetSub));
    expect(existsSync(keeperPath)).toBe(true);
    expect(readFileSync(keeperPath, "utf-8")).toBe("precious data");

    // DELETE
    const res = await app.request(
      `/api/workbench/games/${slug}`,
      { method: "DELETE" },
    );

    // Response ok
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.slug).toBe(slug);

    // Symlink gone
    expect(existsSync(gameDir(slug))).toBe(false);
    // Target content survives
    expect(existsSync(keeperPath)).toBe(true);
    expect(readFileSync(keeperPath, "utf-8")).toBe("precious data");
  });
});

// ── (b) real directory — recursive delete (current rm -rf behavior) ────

describe("DELETE real directory — recursive rm (current behavior)", () => {
  test("real dir is fully removed", async () => {
    const slug = "real-game";
    const dir = gameDir(slug);
    mkdirSync(dir, { recursive: true });
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(resolve(dir, "forge.json"), JSON.stringify({ id: slug }), "utf-8");
    writeFileSync(resolve(dir, "src", "main.ts"), "// game code", "utf-8");

    // Verify setup: real directory, not symlink
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(existsSync(resolve(dir, "forge.json"))).toBe(true);

    const res = await app.request(
      `/api/workbench/games/${slug}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.slug).toBe(slug);

    // Directory fully gone
    expect(existsSync(dir)).toBe(false);
  });
});

// ── (c) dangling symlink — cleanup the broken link ─────────────────────

describe("DELETE dangling symlink — broken link cleaned up", () => {
  test("dangling symlink is removed without error", async () => {
    const slug = "dangling";
    const nonexistentTarget = resolve(projectRoot, "nonexistent-target");
    ensureGamesDir();
    symlinkSync(nonexistentTarget, gameDir(slug), "dir");

    // Verify setup: is a symlink, but target does not exist
    expect(lstatSync(gameDir(slug)).isSymbolicLink()).toBe(true);
    expect(existsSync(gameDir(slug))).toBe(false); // dangling: existsSync follows, so false

    const res = await app.request(
      `/api/workbench/games/${slug}`,
      { method: "DELETE" },
    );

    // Desired behavior: dangling symlink cleaned up
    // RED note: current impl uses existsSync (returns false for dangling)
    // and would 404. After w11 adds lstat, it should detect the symlink
    // and unlink it.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    // Symlink gone
    expect(existsSync(gameDir(slug))).toBe(false);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────

describe("DELETE edge cases", () => {
  test("invalid slug returns 400", async () => {
    const res = await app.request(
      "/api/workbench/games/bad slug!",
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });

  test("non-existent game returns 404", async () => {
    const res = await app.request(
      "/api/workbench/games/no-game",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not found");
  });
});
