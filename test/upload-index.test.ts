// Unit tests for upload orchestration: dry-run plan, the confirm-nonce gate, the
// fail-closed secret gate at execute time, and a full plan→confirm→push flow
// against a local bare repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planUpload, uploadWorkspace, tailUploadLog } from "../src/upload";

let projectRoot: string;
let bare: string;

// See upload-git.test.ts — push to evolve/* to dodge the ambient protected-branch hook.
const TEST_BRANCH = "evolve/upload-test";

function fg(rel: string, content: string) {
  const abs = join(projectRoot, ".forgeax", rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function makeBare(): string {
  const d = mkdtempSync(join(tmpdir(), "fg-bare-"));
  execFileSync("git", ["init", "--bare", "-b", TEST_BRANCH, d]);
  return d;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "fg-idx-"));
  bare = makeBare();
  fg("games/g/src/main.ts", "export const x = 1\n");
  fg("active-game.json", '{"slug":"g"}\n');
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}) =>
  ({ FORGEAX_UPLOAD_GITHUB_TOKEN: "tok", FORGEAX_UPLOAD_REPO: "owner/repo", FORGEAX_UPLOAD_BRANCH: TEST_BRANCH, ...over }) as any;

describe("planUpload (dry-run)", () => {
  test("with token + clean tree → plan with a confirm nonce", () => {
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok) throw new Error("plan failed: " + (p as any).error);
    expect(p.kind).toBe("plan");
    expect(p.fileCount).toBe(2);
    expect(p.tokenConfigured).toBe(true);
    expect(p.nonce).toBeTruthy();
    expect(p.summary).toContain("/upload confirm");
  });

  test("empty token env → built-in token keeps upload configured", () => {
    const p = planUpload({ projectRoot, env: env({ FORGEAX_UPLOAD_GITHUB_TOKEN: "" }) });
    if (!p.ok) throw new Error("unexpected");
    expect(p.tokenConfigured).toBe(true);
    expect(p.nonce).toBeTruthy();
  });

  test("planted secret → no nonce, reported in secretHits", () => {
    fg("souls/forge/MEMORY.md", "remember key sk-" + "a".repeat(24) + "\n");
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok) throw new Error("unexpected");
    expect(p.secretHits.length).toBeGreaterThan(0);
    expect(p.nonce).toBeUndefined();
  });

  test("invalid repo format → failure(no-repo); empty repo falls back to shared default", () => {
    const bad = planUpload({ projectRoot, env: env({ FORGEAX_UPLOAD_REPO: "not-a-repo" }) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("no-repo");
    const viaDefault = planUpload({ projectRoot, env: env({ FORGEAX_UPLOAD_REPO: "" }) });
    expect(viaDefault.ok).toBe(true); // DEFAULT_UPLOAD_REPO applies
  });
});

describe("uploadWorkspace nonce gate", () => {
  test("rejects an unknown nonce", async () => {
    const r = await uploadWorkspace("deadbeef", { projectRoot, env: env(), remoteUrlOverride: bare });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("bad-nonce");
  });

  test("rejects a reused nonce (single-use)", async () => {
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok || !p.nonce) throw new Error("no nonce");
    const r1 = await uploadWorkspace(p.nonce, { projectRoot, env: env(), remoteUrlOverride: bare });
    expect(r1.ok).toBe(true);
    const r2 = await uploadWorkspace(p.nonce, { projectRoot, env: env(), remoteUrlOverride: bare });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.kind).toBe("bad-nonce");
  });

  test("rejects a nonce planned for a different workspace", async () => {
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok || !p.nonce) throw new Error("no nonce");
    const otherRoot = mkdtempSync(join(tmpdir(), "fg-idx2-"));
    try {
      mkdirSync(join(otherRoot, ".forgeax/games/h"), { recursive: true });
      writeFileSync(join(otherRoot, ".forgeax/games/h/x.ts"), "x\n");
      const r = await uploadWorkspace(p.nonce, { projectRoot: otherRoot, env: env(), remoteUrlOverride: bare });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("bad-nonce");
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("full plan → confirm → push", () => {
  test("pushes the subset to the bare repo and writes an audit log", async () => {
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok || !p.nonce) throw new Error("no nonce");
    const r = await uploadWorkspace(p.nonce, { projectRoot, env: env(), remoteUrlOverride: bare });
    if (!r.ok) throw new Error("upload failed: " + r.error);
    expect(r.kind).toBe("result");
    expect(r.filesChanged).toBe(2);
    expect(r.sourceFileCount).toBe(2);
    expect(r.sourceBytes).toBeGreaterThan(0);
    expect(r.archiveBytes).toBeGreaterThan(0);
    expect(r.summary).toContain("archive");

    // verify the remote archive round-trips
    const wt = mkdtempSync(join(tmpdir(), "fg-verify-"));
    execFileSync("git", ["clone", "-q", bare, wt]);
    expect(existsSync(join(wt, r.path, "workspace.tar.gz"))).toBe(true);
    expect(existsSync(join(wt, r.path, "manifest.json"))).toBe(true);
    const unpacked = mkdtempSync(join(tmpdir(), "fg-unpack-"));
    execFileSync("tar", ["-xzf", join(wt, r.path, "workspace.tar.gz"), "-C", unpacked]);
    expect(readFileSync(join(unpacked, "games/g/src/main.ts"), "utf8")).toBe("export const x = 1\n");
    rmSync(unpacked, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });

    // audit log has started + completed
    const log = tailUploadLog({ projectRoot });
    const outcomes = log.entries.map((e: any) => e.outcome);
    expect(outcomes).toContain("started");
    expect(outcomes).toContain("completed");
  });

  test("execute re-scan blocks a secret introduced after the plan", async () => {
    const p = planUpload({ projectRoot, env: env() });
    if (!p.ok || !p.nonce) throw new Error("no nonce");
    // plant a secret AFTER planning but BEFORE confirm
    fg("games/g/src/leak.ts", "const T='ghp_" + "z".repeat(36) + "'\n");
    const r = await uploadWorkspace(p.nonce, { projectRoot, env: env(), remoteUrlOverride: bare });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("secret-detected");
  });
});
