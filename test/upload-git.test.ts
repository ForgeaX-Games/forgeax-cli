// Integration tests for the git uploader against a local bare repository.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_FILENAME, MANIFEST_FILENAME, buildUploadArchive, type UploadArchive } from "../src/upload/archive";
import { pushSubset, snapshotDirName, type PushSubsetParams } from "../src/upload/git-uploader";
import type { UploadFile } from "../src/upload/manifest";

let bare: string;
let src: string;
const archives: UploadArchive[] = [];
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

async function makeArchive(files: UploadFile[]): Promise<UploadArchive> {
  const value = await buildUploadArchive(files);
  archives.push(value);
  return value;
}

function checkout(branch = TEST_BRANCH): string {
  const d = mkdtempSync(join(tmpdir(), "fg-verify-"));
  execFileSync("git", ["clone", "-q", "-b", branch, bare, d]);
  return d;
}

const baseParams = (archive: UploadArchive, over: Partial<PushSubsetParams> = {}): PushSubsetParams => ({
  remoteUrl: bare,
  branch: TEST_BRANCH,
  namespace: "ws-aaaa",
  snapshotDir: SNAP1,
  archive,
  commitMessage: "upload: ws-aaaa",
  sleep: async () => {},
  ...over,
});

beforeEach(() => {
  bare = makeBare();
  src = mkdtempSync(join(tmpdir(), "fg-src-"));
});
afterEach(() => {
  for (const value of archives.splice(0)) value.cleanup();
  rmSync(bare, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

describe("snapshotDirName", () => {
  test("is lexically sortable local time", () => {
    expect(snapshotDirName(new Date(2026, 6, 9, 18, 30, 55))).toBe("2026-07-09_183055");
  });
});

describe("pushSubset", () => {
  test("first push creates one archive plus one manifest", async () => {
    const archive = await makeArchive([writeSrc("games/g/src/main.ts", "x=1\n"), writeSrc("active-game.json", "{}\n")]);
    const res = await pushSubset(baseParams(archive));
    expect(res.skipped).toBe(false);
    expect(res.filesChanged).toBe(2);
    expect(res.sourceFileCount).toBe(2);
    expect(res.path).toBe(`ws-aaaa/data/${SNAP1}`);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);

    const wt = checkout();
    expect(existsSync(join(wt, res.path, ARCHIVE_FILENAME))).toBe(true);
    expect(existsSync(join(wt, res.path, MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(join(wt, res.path, "games"))).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  test("identical re-upload is skipped without a new snapshot", async () => {
    const files = [writeSrc("games/g/a.ts", "a\n")];
    const r1 = await pushSubset(baseParams(await makeArchive(files)));
    const r2 = await pushSubset(baseParams(await makeArchive(files), { snapshotDir: SNAP2 }));
    expect(r2.skipped).toBe(true);
    expect(r2.commit).toBe(r1.commit);
    expect(r2.path).toBe(`ws-aaaa/data/${SNAP1}`);

    const wt = checkout();
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP2}`))).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  test("changed content creates a new immutable archive snapshot", async () => {
    const a = writeSrc("games/g/a.ts", "a\n");
    const b = writeSrc("games/g/b.ts", "b\n");
    await pushSubset(baseParams(await makeArchive([a, b])));
    const a2 = writeSrc("games/g/a.ts", "a2\n");
    const result = await pushSubset(baseParams(await makeArchive([a2]), { snapshotDir: SNAP2 }));
    expect(result.skipped).toBe(false);

    const wt = checkout();
    const out1 = mkdtempSync(join(tmpdir(), "fg-unpack-"));
    const out2 = mkdtempSync(join(tmpdir(), "fg-unpack-"));
    try {
      execFileSync("tar", ["-xzf", join(wt, `ws-aaaa/data/${SNAP1}/${ARCHIVE_FILENAME}`), "-C", out1]);
      execFileSync("tar", ["-xzf", join(wt, `ws-aaaa/data/${SNAP2}/${ARCHIVE_FILENAME}`), "-C", out2]);
      expect(readFileSync(join(out1, "games/g/a.ts"), "utf8")).toBe("a\n");
      expect(existsSync(join(out1, "games/g/b.ts"))).toBe(true);
      expect(readFileSync(join(out2, "games/g/a.ts"), "utf8")).toBe("a2\n");
      expect(existsSync(join(out2, "games/g/b.ts"))).toBe(false);
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(out1, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  });

  test("empty source archive is refused", async () => {
    await expect(pushSubset(baseParams(await makeArchive([])))).rejects.toMatchObject({ kind: "empty-set" });
  });

  test("namespace isolation leaves the other namespace untouched", async () => {
    await pushSubset(baseParams(await makeArchive([writeSrc("games/g/a.ts", "A\n")])));
    await pushSubset(baseParams(await makeArchive([writeSrc("games/h/b.ts", "B\n")]), {
      namespace: "ws-bbbb",
      commitMessage: "upload: ws-bbbb",
    }));
    const wt = checkout();
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/${ARCHIVE_FILENAME}`))).toBe(true);
    expect(existsSync(join(wt, `ws-bbbb/data/${SNAP1}/${ARCHIVE_FILENAME}`))).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  test("missing target branch on non-empty remote leaks no default-branch files", async () => {
    const seed = mkdtempSync(join(tmpdir(), "fg-seed-"));
    execFileSync("git", ["clone", "-q", bare, seed]);
    writeFileSync(join(seed, "README.md"), "counterparty readme\n");
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: seed });
    execFileSync("git", ["push", "-q", "origin", TEST_BRANCH], { cwd: seed });
    rmSync(seed, { recursive: true, force: true });

    const other = "evolve/upload-test-2";
    const result = await pushSubset(baseParams(await makeArchive([writeSrc("games/g/a.ts", "a\n")]), { branch: other }));
    expect(result.filesChanged).toBe(2);
    const wt = checkout(other);
    expect(existsSync(join(wt, `ws-aaaa/data/${SNAP1}/${ARCHIVE_FILENAME}`))).toBe(true);
    expect(existsSync(join(wt, "README.md"))).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  test("token/auth header never lands in git config", async () => {
    await pushSubset(baseParams(await makeArchive([writeSrc("games/g/a.ts", "a")])));
    const wt = checkout();
    const config = readFileSync(join(wt, ".git/config"), "utf8");
    expect(config).not.toContain("http.extraHeader");
    expect(config).not.toContain("AUTHORIZATION");
    rmSync(wt, { recursive: true, force: true });
  });
});
