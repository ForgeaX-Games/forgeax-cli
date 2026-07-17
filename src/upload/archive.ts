// Deterministic single-file snapshot archive.
//
// Git is good at deduplicating ordinary source trees, but asking it to index tens of
// thousands of tiny runtime/session files dominates upload time. New snapshots
// therefore contain exactly two files:
//   workspace.tar.gz — the restorable `.forgeax` tree
//   manifest.json    — the canonical content fingerprint + archive metadata
//
// The tar stream is deterministic: sorted paths and normalized metadata. Each source
// file is read once while we scan for secrets, hash it, and feed gzip.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, constants as zlibConstants } from "node:zlib";
import { scanBufferForSecrets, type SecretHit, type UploadFile } from "./manifest";

export const ARCHIVE_FILENAME = "workspace.tar.gz";
export const MANIFEST_FILENAME = "manifest.json";
/** Leave headroom below GitHub's hard 100 MiB single-blob limit. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 95 * 1024 * 1024;

export interface UploadArchiveFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface UploadArchiveManifest {
  version: 1;
  format: "forgeax-workspace-tar-gz";
  contentHash: string;
  sourceFileCount: number;
  sourceBytes: number;
  archiveBytes: number;
  files: UploadArchiveFile[];
}

export interface UploadArchive {
  archivePath: string;
  manifest: UploadArchiveManifest;
  secretHits: SecretHit[];
  cleanup(): void;
}

export class UploadArchiveError extends Error {
  constructor(public readonly kind: "archive-too-large" | "archive-failed", message: string) {
    super(message);
    this.name = "UploadArchiveError";
  }
}

export interface BuildUploadArchiveOptions {
  literals?: string[];
  maxArchiveBytes?: number;
}

/** Build a deterministic tar.gz in a private temporary directory. Caller must cleanup. */
export async function buildUploadArchive(
  files: UploadFile[],
  opts: BuildUploadArchiveOptions = {},
): Promise<UploadArchive> {
  const dir = mkdtempSync(join(tmpdir(), "forgeax-archive-"));
  const archivePath = join(dir, ARCHIVE_FILENAME);
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  const entries: UploadArchiveFile[] = [];
  const secretHits: SecretHit[] = [];
  const content = createHash("sha256");
  let sourceBytes = 0;

  const chunks = async function* () {
    for (const file of sorted) {
      validateArchivePath(file.rel);
      let buf: Buffer;
      try {
        buf = readFileSync(file.abs);
      } catch (e) {
        throw new UploadArchiveError("archive-failed", `cannot read upload source ${file.rel}: ${(e as Error).message}`);
      }
      // The walk and archive must describe the same bytes. A file changing between
      // them is retried by the user rather than silently producing a misleading plan.
      if (buf.byteLength !== file.bytes) {
        throw new UploadArchiveError("archive-failed", `upload source changed while archiving: ${file.rel} — run upload again`);
      }

      secretHits.push(...scanBufferForSecrets(file.rel, buf, opts.literals ?? []));
      const sha256 = createHash("sha256").update(buf).digest("hex");
      entries.push({ path: file.rel, bytes: buf.byteLength, sha256 });
      sourceBytes += buf.byteLength;
      updateContentHash(content, file.rel, buf.byteLength, sha256);

      yield tarHeader(file.rel, buf.byteLength);
      yield buf;
      const padding = (512 - (buf.byteLength % 512)) % 512;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024); // POSIX tar end marker: two empty records.
  };

  try {
    await pipeline(
      Readable.from(chunks(), { objectMode: false }),
      createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
      createWriteStream(archivePath, { mode: 0o600 }),
    );
    const archiveBytes = statSync(archivePath).size;
    const maxArchiveBytes = opts.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (archiveBytes > maxArchiveBytes) {
      throw new UploadArchiveError(
        "archive-too-large",
        `compressed upload is ${formatBytes(archiveBytes)}, above the ${formatBytes(maxArchiveBytes)} limit — remove large generated content or use external storage`,
      );
    }

    return {
      archivePath,
      manifest: {
        version: 1,
        format: "forgeax-workspace-tar-gz",
        contentHash: content.digest("hex"),
        sourceFileCount: entries.length,
        sourceBytes,
        archiveBytes,
        files: entries,
      },
      secretHits,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e instanceof UploadArchiveError) throw e;
    throw new UploadArchiveError("archive-failed", `failed to build upload archive: ${(e as Error).message}`);
  }
}

/** Read a manifest written by this module. Used by tests and the git dedup path. */
export function parseUploadArchiveManifest(raw: string): UploadArchiveManifest | null {
  try {
    const v = JSON.parse(raw) as Partial<UploadArchiveManifest>;
    if (
      v.version !== 1 ||
      v.format !== "forgeax-workspace-tar-gz" ||
      typeof v.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(v.contentHash) ||
      typeof v.sourceFileCount !== "number" ||
      typeof v.sourceBytes !== "number" ||
      typeof v.archiveBytes !== "number" ||
      !Array.isArray(v.files)
    ) return null;
    return v as UploadArchiveManifest;
  } catch {
    return null;
  }
}

export function serializeUploadArchiveManifest(manifest: UploadArchiveManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

function updateContentHash(hash: ReturnType<typeof createHash>, path: string, bytes: number, sha256: string): void {
  const pathBytes = Buffer.from(path, "utf8");
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes));
  hash.update(size);
  hash.update(Buffer.from([0]));
  hash.update(pathBytes);
  hash.update(Buffer.from([0]));
  hash.update(sha256, "ascii");
  hash.update(Buffer.from([0]));
}

function validateArchivePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new UploadArchiveError("archive-failed", `unsafe upload archive path: ${path || "<empty>"}`);
  }
}

function tarHeader(path: string, bytes: number): Buffer {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes);
  writeOctal(header, 136, 12, 0); // normalized mtime
  header.fill(0x20, 148, 156); // checksum field is spaces while summing
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, encoded);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const slashes: number[] = [];
  for (let i = 0; i < path.length; i++) if (path[i] === "/") slashes.push(i);
  for (let i = slashes.length - 1; i >= 0; i--) {
    const at = slashes[i]!;
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new UploadArchiveError("archive-failed", `upload path exceeds the tar limit: ${basename(path)}`);
}

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const src = Buffer.from(value, "utf8");
  if (src.length > length) throw new UploadArchiveError("archive-failed", `tar header field exceeds ${length} bytes`);
  src.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length > length) throw new UploadArchiveError("archive-failed", "upload file is too large for tar");
  writeString(buf, offset, length, encoded);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
