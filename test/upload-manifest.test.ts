// Unit tests for the upload manifest — the SSOT exclude predicate, tree walk,
// symlink/backup/size handling, and the fail-closed content secret scan.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isBackupDir,
  isExcluded,
  isIncludedRoot,
  scanContentForSecrets,
  scanFilesForSecrets,
  sensitiveEnvLiterals,
  walkUploadTree,
} from "../src/upload/manifest";

describe("isExcluded predicate", () => {
  test("sessions/workbench upload now (whole-directory policy, 2026-07-09)", () => {
    expect(isExcluded("games/moo/sessions/abc/events.json")).toBe(false);
    expect(isExcluded("sessions")).toBe(false);
    expect(isExcluded("workbench/layout.json")).toBe(false);
  });
  test("keeps real game source", () => {
    expect(isExcluded("games/moo/src/main.ts")).toBe(false);
    expect(isExcluded("games/moo/reel/scenarios.json")).toBe(false);
    expect(isExcluded("active-game.json")).toBe(false);
  });
  test("prunes logs/debug/node_modules/cache/run/sentinels/playwright-mcp/chrome-profile", () => {
    for (const seg of ["logs", "debug", "node_modules", "cache", "run", "sentinels", "playwright-mcp", "chrome-webgpu-profile"]) {
      expect(isExcluded(`games/x/${seg}/f`)).toBe(true);
    }
  });
  test("prunes backup dirs by directory-name predicate", () => {
    expect(isBackupDir("cow-level.bak-1781237317")).toBe(true);
    expect(isBackupDir("cow-level")).toBe(false);
    expect(isExcluded("games/cow-level.bak-1781237317/assets/a.glb")).toBe(true);
  });
  test("excludes secret/runtime basenames + suffixes + upload bookkeeping", () => {
    expect(isExcluded("prefs/browser-localStorage.json")).toBe(true);
    expect(isExcluded("dev-stack.env")).toBe(true);
    expect(isExcluded("upload.json")).toBe(true);
    expect(isExcluded("keys.yaml")).toBe(true);
    expect(isExcluded("upload-log.jsonl")).toBe(true);
    expect(isExcluded("games/x/a.jsonl")).toBe(false); // data ledgers upload now
    expect(isExcluded("foo.pem")).toBe(true);
    expect(isExcluded("foo.env")).toBe(true);
  });
  test("top-level: everything not denied is uploadable", () => {
    expect(isIncludedRoot("games")).toBe(true);
    expect(isIncludedRoot("sessions")).toBe(true);
    expect(isIncludedRoot("anything-else")).toBe(true);
    expect(isIncludedRoot("playwright-mcp")).toBe(false);
    expect(isIncludedRoot("logs")).toBe(false);
  });
});

describe("walkUploadTree", () => {
  let root: string; // a fake .forgeax
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fg-walk-"));
    // include roots
    mkdirSync(join(root, "games/moo/src"), { recursive: true });
    writeFileSync(join(root, "games/moo/src/main.ts"), "export const x = 1\n");
    mkdirSync(join(root, "games/moo/sessions/s1"), { recursive: true });
    writeFileSync(join(root, "games/moo/sessions/s1/events.jsonl"), "{}\n"); // must be excluded
    mkdirSync(join(root, "games/old.bak-123/assets"), { recursive: true });
    writeFileSync(join(root, "games/old.bak-123/assets/a.txt"), "x"); // backup → excluded
    mkdirSync(join(root, "souls/forge"), { recursive: true });
    writeFileSync(join(root, "souls/forge/MEMORY.md"), "notes\n");
    writeFileSync(join(root, "active-game.json"), '{"slug":"moo"}\n');
    // excluded top-level
    mkdirSync(join(root, "playwright-mcp/x"), { recursive: true });
    writeFileSync(join(root, "playwright-mcp/x/cache.bin"), "junk");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs/debug.log"), "log");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("collects the whole tree minus deny rules (sessions included now)", () => {
    const r = walkUploadTree(root);
    const rels = r.files.map((f) => f.rel).sort();
    expect(rels).toEqual([
      "active-game.json",
      "games/moo/sessions/s1/events.jsonl",
      "games/moo/src/main.ts",
      "souls/forge/MEMORY.md",
    ]);
  });

  test("drops backup dirs and excluded top-level trees", () => {
    const rels = walkUploadTree(root).files.map((f) => f.rel);
    expect(rels.some((p) => p.includes(".bak-"))).toBe(false);
    expect(rels.some((p) => p.startsWith("playwright-mcp"))).toBe(false);
    expect(rels.some((p) => p.startsWith("logs"))).toBe(false);
  });

  test("skips symlinked game dirs (monorepo samples) and reports them", () => {
    const realTarget = mkdtempSync(join(tmpdir(), "fg-sample-"));
    writeFileSync(join(realTarget, "engine-src.ts"), "secret monorepo source");
    symlinkSync(realTarget, join(root, "games/sample-link"));
    const r = walkUploadTree(root);
    expect(r.files.some((f) => f.rel.includes("sample-link"))).toBe(false);
    expect(r.skippedSymlinks.map((s) => s.rel)).toContain("games/sample-link");
    rmSync(realTarget, { recursive: true, force: true });
  });

  test("enforces size gate", () => {
    writeFileSync(join(root, "games/moo/big.bin"), Buffer.alloc(2048));
    const r = walkUploadTree(root, { maxFileBytes: 1024 });
    expect(r.files.some((f) => f.rel === "games/moo/big.bin")).toBe(false);
    expect(r.skippedLarge.map((s) => s.rel)).toContain("games/moo/big.bin");
  });

  test("missing .forgeax → empty result, no throw", () => {
    const r = walkUploadTree(join(root, "does-not-exist"));
    expect(r.files).toEqual([]);
  });
});

describe("secret scan (fail-closed)", () => {
  test("detects common credential shapes", () => {
    expect(scanContentForSecrets("a", "key=sk-abcdefghijklmnopqrstuvwx", []).length).toBeGreaterThan(0);
    expect(scanContentForSecrets("a", "ghp_" + "a".repeat(36), []).length).toBeGreaterThan(0);
    expect(scanContentForSecrets("a", "AKIA" + "ABCDEFGHIJ123456", []).length).toBeGreaterThan(0);
    expect(scanContentForSecrets("a", "-----BEGIN OPENSSH PRIVATE KEY-----", []).length).toBeGreaterThan(0);
  });
  test("detects an sk-ant- key (hyphens defeat the plain sk- pattern)", () => {
    const hits = scanContentForSecrets("souls/m.md", "use sk-ant-api03-" + "aB3-_x".repeat(8), []);
    expect(hits.find((h) => h.kind === "anthropic-key")).toBeTruthy();
  });
  test("detects non-classic GitHub token prefixes (gho_/ghs_)", () => {
    expect(scanContentForSecrets("a", "gho_" + "b".repeat(36), []).length).toBeGreaterThan(0);
    expect(scanContentForSecrets("a", "ghs_" + "c".repeat(36), []).length).toBeGreaterThan(0);
  });
  test("detects literal env-secret values", () => {
    const hits = scanContentForSecrets("g/src.ts", "const T = 'super-secret-token-value'", ["super-secret-token-value"]);
    expect(hits.find((h) => h.kind === "env-secret-literal")).toBeTruthy();
  });
  test("clean content → no hits", () => {
    expect(scanContentForSecrets("a", "const x = 1; // nothing here", ["zzz-unused-literal"])).toEqual([]);
  });
  test("sensitiveEnvLiterals filters short/empty values", () => {
    const lits = sensitiveEnvLiterals({ FORGEAX_UPLOAD_GITHUB_TOKEN: "abcdefghij", ANTHROPIC_API_KEY: "x" } as any);
    expect(lits).toContain("abcdefghij");
    expect(lits).not.toContain("x");
  });
  test("scanFilesForSecrets flags a token planted in a game file", () => {
    const root = mkdtempSync(join(tmpdir(), "fg-scan-"));
    mkdirSync(join(root, "games/g/src"), { recursive: true });
    const abs = join(root, "games/g/src/leak.ts");
    writeFileSync(abs, "const TOKEN = 'ghp_" + "b".repeat(36) + "'\n");
    const hits = scanFilesForSecrets([{ abs, rel: "games/g/src/leak.ts", bytes: 50 }], []);
    expect(hits.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});
