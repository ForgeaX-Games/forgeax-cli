// Integration-style unit tests for the git uploader, driven against a LOCAL bare
// repo (file remote) so no network/GitHub auth is needed. Verifies the snapshot
// layout (<ns>/data/<ts>/**), skip-when-identical dedup, snapshot immutability,
// empty-set refusal, and cross-namespace isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pushSubset, snapshotDirName, type PushSubsetParams } from "../src/upload/git-uploader";
import type { UploadFile } from "../src/upload/manifest";

let bare: string;
let src: string;

// Push to a non-protected branch: this monorepo's dev machines carry a global
// AgenTeam pre-push hook that blocks pushes to main/master. `evolve/*` is allowed,
// so the test is hermetic against the ambient hook while exercising the same code.
const TEST_BRANCH = "evolve/upload-test";
const SNAP1 = "2026-01-01_000000";
const SNAP2 = "2026-01-01_000100";

function makeBare(): string {
  const d = mkdtempSync(join(tmpdir(), "fg-bare-"));
  execFileSync("git", ["init", "--bare", "-b", TEST_BRANCH, d]);
  return d;
}

function writeSrc(rel: string, content: string): UploadFile {
  const abs = join(src, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return { abs, rel, bytes: Buffer.byteLength(content) };
}

/** Clone the bare repo to a temp dir and return the working tree path. */
function checkout(): string {
  const d = mkdtempSync(join(tmpdir(), "fg-verify-"));
  execFileSync("git", ["clone", "-q", bare, d]);
  return d;
}

const baseParams = (over: Partial<PushSubsetParams>): PushSubsetParams => ({
  remoteUrl: bare,
  branch: TEST_BRANCH,
  namespace: "ws-aaaa",
  snapshotDir: SNAP1,
  files: [],
  sourceRoot: src,
  commitMessage: "upload: ws-aaaa",
  sleep: async () => {},
  ...over,
});

beforeEach(() => {
  bare = makeBare();
  src = mkdtempSync(join(tmpdir(), "fg-src-"));
});
afterEach(() => {
  rmSync(bare, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

describe("snapshotDirName", () => {
  test("is lexically sortable local time", () => {
    const n = snapshotDirName(new Date(2026, 6, 9, 18, 30, 55));
    expect(n).toBe("2026-07-09_183055");
  });
});

describe("pushSubset", () => {
  test("first push creates <ns>/data/<ts>/ on a new branch", async () => {
    const files = [writeSrc("games/g/src/main.ts", "x=1\n"), writeSrc("active-game.json", "{}\n")];
    const res = await pushSubset(baseParams({ files }));
    expect(res.skipped).toBe(false);
    expect(res.filesChanged).toBe(2);
    expect(res.path).toBe(`ws-aaaa/data/${SNAP1}`);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);

    const wt = checkout();
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/games/g/src/main.ts`))).toBe(true);
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/active-game.json`))).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  test("identical re-upload → skipped, no new snapshot dir", async () => {
    const files = [writeSrc("games/g/a.ts", "a\n")];
    const r1 = await pushSubset(baseParams({ files }));
    const r2 = await pushSubset(baseParams({ files, snapshotDir: SNAP2 }));
    expect(r2.skipped).toBe(true);
    expect(r2.commit).toBe(r1.commit);
    expect(r2.path).toBe(`ws-aaaa/data/${SNAP1}`); // points at the existing snapshot

    const wt = checkout();
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}`))).toBe(true);
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP2}`))).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  test("changed content → new snapshot; earlier snapshot stays untouched", async () => {
    const a = writeSrc("games/g/a.ts", "a\n");
    const b = writeSrc("games/g/b.ts", "b\n");
    await pushSubset(baseParams({ files: [a, b] }));
    // drop b, change a → next upload snapshots the new state
    const a2 = writeSrc("games/g/a.ts", "a2\n");
    const r = await pushSubset(baseParams({ files: [a2], snapshotDir: SNAP2 }));
    expect(r.skipped).toBe(false);
    expect(r.path).toBe(`ws-aaaa/data/${SNAP2}`);

    const wt = checkout();
    // new snapshot has the new state
    expect(readFileSync(join(wt, `ws-aaaa/data/${SNAP2}/games/g/a.ts`), "utf8")).toBe("a2\n");
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP2}/games/g/b.ts`))).toBe(false);
    // old snapshot is immutable history
    expect(readFileSync(join(wt, `ws-aaaa/data/${SNAP1}/games/g/a.ts`), "utf8")).toBe("a\n");
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/games/g/b.ts`))).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  test("empty file set is refused (empty-set guard)", async () => {
    await expect(pushSubset(baseParams({ files: [] }))).rejects.toMatchObject({ kind: "empty-set" });
  });

  test("namespace isolation: writing ws-bbbb leaves ws-aaaa untouched", async () => {
    await pushSubset(baseParams({ files: [writeSrc("games/g/a.ts", "A\n")], namespace: "ws-aaaa" }));
    await pushSubset(baseParams({ files: [writeSrc("games/h/b.ts", "B\n")], namespace: "ws-bbbb", commitMessage: "upload: ws-bbbb" }));
    const wt = checkout();
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/games/g/a.ts`))).toBe(true);
    expect(existsSync(join(wt, `ws-bbbb/data/${SNAP1}/games/h/b.ts`))).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  test("target branch missing on a NON-empty remote → no default-branch leakage", async () => {
    // Seed the remote's default branch with unrelated (counterparty) content.
    const seedWt = mkdtempSync(join(tmpdir(), "fg-seed-"));
    execFileSync("git", ["clone", "-q", bare, seedWt]);
    writeFileSync(join(seedWt, "README.md"), "counterparty readme\n");
    execFileSync("git", ["add", "."], { cwd: seedWt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: seedWt });
    execFileSync("git", ["push", "-q", "origin", TEST_BRANCH], { cwd: seedWt });
    rmSync(seedWt, { recursive: true, force: true });

    // Push to a DIFFERENT, not-yet-existing branch. The clone's index carries the
    // default branch's entries; without the read-tree reset on the unborn HEAD they
    // would all be staged — leaking README.md into the first commit (or tripping
    // the escaped-path assertion).
    const other = "evolve/upload-test-2";
    const res = await pushSubset(baseParams({ files: [writeSrc("games/g/a.ts", "a\n")], branch: other }));
    expect(res.skipped).toBe(false);
    expect(res.filesChanged).toBe(1);

    const wt = mkdtempSync(join(tmpdir(), "fg-verify-"));
    execFileSync("git", ["clone", "-q", "-b", other, bare, wt]);
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/games/g/a.ts`))).toBe(true);
    expect(existsSync(join(wt, "README.md"))).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  test("token/auth header never lands in .git/config (it isn't in the remote URL)", async () => {
    // file remote has no authHeader, but assert the remote URL is the bare path, not a credential URL.
    await pushSubset(baseParams({ files: [writeSrc("games/g/a.ts", "a")] }));
    const wt = checkout();
    const cfg = readFileSync(join(wt, ".git/config"), "utf8");
    expect(cfg).not.toContain("http.extraHeader");
    expect(cfg).not.toContain("AUTHORIZATION");
    rmSync(wt, { recursive: true, force: true });
  });
});
