import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";

// M1 w1 — path-manager unit test: gameDir resolution + INVALID_SLUG.
//
// These tests verify that UserLayer.gameDir(slug) resolves to an
// instance-local path (<projectRoot>/.forgeax/games/<slug>) rather than
// the old user-global ~/.forgeax/games/<slug> (bug-20260522 R1).
//
// Written red-first (TDD): currently gameDir returns ~/.forgeax/games/<slug>,
// so tests asserting instance-local paths will fail. After w2 implements
// the projectRoot injection, these tests turn green.

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-pm-"));
  resetPathManager();
  initPathManager({ projectRoot });
});

afterEach(() => {
  resetPathManager();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("UserLayer.gameDir(slug) — instance-local resolution", () => {
  test("slug 'best-teris' resolves to <projectRoot>/.forgeax/games/best-teris", () => {
    const pm = getPathManager();
    const result = pm.user().gameDir("best-teris");
    const expected = resolve(projectRoot, ".forgeax", "games", "best-teris");
    expect(result).toBe(expected);
  });

  test("slug 'snake' is not under homedir ~/.forgeax", () => {
    const pm = getPathManager();
    const result = pm.user().gameDir("snake");
    // Must NOT start with the old user-global ~/.forgeax/games path.
    expect(result.includes("/.forgeax/games/")).toBe(true);
    // The resolved path must be under our temp projectRoot, not homedir.
    expect(result.startsWith(projectRoot)).toBe(true);
  });

  test("gamesDir() returns <projectRoot>/.forgeax/games", () => {
    const pm = getPathManager();
    const result = pm.user().gamesDir();
    const expected = resolve(projectRoot, ".forgeax", "games");
    expect(result).toBe(expected);
  });

  test("gamesDir() is not under user-global ~/.forgeax", () => {
    const pm = getPathManager();
    const result = pm.user().gamesDir();
    expect(result.startsWith(projectRoot)).toBe(true);
  });
});

describe("UserLayer.gameDir(slug) — INVALID_SLUG error paths", () => {
  test("slug with '/' throws Error", () => {
    const pm = getPathManager();
    expect(() => pm.user().gameDir("bad/game")).toThrow("PathManager: unsafe path segment");
  });

  test("slug with '\\' throws Error", () => {
    const pm = getPathManager();
    expect(() => pm.user().gameDir("bad\\game")).toThrow("PathManager: unsafe path segment");
  });

  test("slug '..' throws Error", () => {
    const pm = getPathManager();
    expect(() => pm.user().gameDir("..")).toThrow("PathManager: unsafe path segment");
  });

  test("absolute-path slug throws Error", () => {
    const pm = getPathManager();
    expect(() => pm.user().gameDir("/etc/passwd")).toThrow("PathManager: unsafe path segment");
  });

  test("empty slug throws Error", () => {
    const pm = getPathManager();
    expect(() => pm.user().gameDir("")).toThrow("PathManager: unsafe path segment");
  });
});

describe("UserLayer non-game methods — still user-global", () => {
  test("root() returns user-level ~/.forgeax", () => {
    const pm = getPathManager();
    // root() should still be the user-global dir, not projectRoot-based.
    const userRoot = pm.user().root();
    // With initPathManager({ projectRoot }) but no userRoot, it falls back
    // to the default resolveUserDir (homedir/.forgeax). Verify it's not
    // under projectRoot.
    expect(userRoot).not.toBe(projectRoot);
  });

  test("sessionsDir() returns user-global sessions path", () => {
    const pm = getPathManager();
    const result = pm.user().sessionsDir();
    // Must still be under user-global ~/.forgeax, not projectRoot.
    expect(result.startsWith(projectRoot)).toBe(false);
  });
});

// ── AC-01 contract test (w4) ──────────────────────────────────────────────
// Verifies that workbench's original create path
// (resolve(projectRoot, '.forgeax/games', slug)) equals
// pm.user().gameDir(slug) after realpath normalization.

describe("AC-01 contract: create path === path-manager resolution", () => {
  test("pm.user().gameDir(slug) equals resolve(projectRoot, '.forgeax/games', slug)", () => {
    const slug = "test-contract";
    const pm = getPathManager();
    const viaPM = pm.user().gameDir(slug);
    const viaManual = resolve(projectRoot, ".forgeax", "games", slug);
    expect(viaPM).toBe(viaManual);
  });
});