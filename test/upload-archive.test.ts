import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARCHIVE_FILENAME,
  UploadArchiveError,
  buildUploadArchive,
  parseUploadArchiveManifest,
  serializeUploadArchiveManifest,
} from "../src/upload/archive";
import type { UploadFile } from "../src/upload/manifest";

let root: string;
const cleanups: (() => void)[] = [];

function file(rel: string, content: string | Buffer): UploadFile {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return { abs, rel, bytes: Buffer.byteLength(content) };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fg-archive-test-")); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("buildUploadArchive", () => {
  test("is deterministic across input order and source mtimes", async () => {
    const a = file("games/g/a.ts", "a\n");
    const b = file("active-game.json", "{}\n");
    const first = await buildUploadArchive([a, b]);
    cleanups.push(first.cleanup);
    const firstBytes = readFileSync(first.archivePath);

    utimesSync(a.abs, new Date(2030, 1, 1), new Date(2030, 1, 1));
    const second = await buildUploadArchive([b, a]);
    cleanups.push(second.cleanup);
    expect(readFileSync(second.archivePath)).toEqual(firstBytes);
    expect(second.manifest.contentHash).toBe(first.manifest.contentHash);
    expect(second.manifest.files.map((f) => f.path)).toEqual(["active-game.json", "games/g/a.ts"]);
  });

  test("round-trips regular, empty, and ustar-prefix paths", async () => {
    const long = `${"directory/".repeat(10)}file.txt`;
    const archive = await buildUploadArchive([
      file("empty.txt", ""),
      file("binary.bin", Buffer.from([0, 1, 2, 3])),
      file(long, "long path\n"),
    ]);
    cleanups.push(archive.cleanup);
    const dest = mkdtempSync(join(tmpdir(), "fg-archive-out-"));
    try {
      execFileSync("tar", ["-xzf", archive.archivePath, "-C", dest]);
      expect(readFileSync(join(dest, "empty.txt"))).toEqual(Buffer.alloc(0));
      expect(readFileSync(join(dest, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
      expect(readFileSync(join(dest, long), "utf8")).toBe("long path\n");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("manifest is self-describing and parseable", async () => {
    const archive = await buildUploadArchive([file("a.txt", "hello")]);
    cleanups.push(archive.cleanup);
    expect(archive.manifest.sourceFileCount).toBe(1);
    expect(archive.manifest.sourceBytes).toBe(5);
    expect(archive.manifest.archiveBytes).toBeGreaterThan(0);
    expect(archive.manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseUploadArchiveManifest(serializeUploadArchiveManifest(archive.manifest))).toEqual(archive.manifest);
    expect(parseUploadArchiveManifest("{}")) .toBeNull();
    expect(ARCHIVE_FILENAME).toBe("workspace.tar.gz");
  });

  test("scans the exact archived bytes for secrets", async () => {
    const archive = await buildUploadArchive([file("leak.txt", "ghp_" + "x".repeat(36))]);
    cleanups.push(archive.cleanup);
    expect(archive.secretHits.some((h) => h.kind === "github-token")).toBe(true);
  });

  test("rejects an archive over the configured limit", async () => {
    await expect(buildUploadArchive([file("a.txt", "hello")], { maxArchiveBytes: 1 }))
      .rejects.toMatchObject({ kind: "archive-too-large" } satisfies Partial<UploadArchiveError>);
  });
});
