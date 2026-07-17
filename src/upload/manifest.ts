// SSOT for "what leaves the workspace" + the fail-closed secret gate.
//
// Policy (decision 2026-07-09, product owner): upload the ENTIRE `.forgeax`
// directory — everything a user could want to restore — EXCEPT:
//   - runtime garbage that regenerates itself (playwright cache, run/lock/
//     sentinels, logs, node_modules, cache)
//   - secret-bearing files by name (.env / .key / .pem / dev-stack.env …)
//   - the upload feature's own local bookkeeping (upload.json / upload-log.jsonl)
// A content-level secret scan (below) remains the fail-closed safety net for
// anything the name rules can't see.
//
// One recursive predicate (isExcluded) is reused by the include-walk and any deny
// check, so exclusion is decided in ONE place. Walk semantics are deliberately
// explicit (segment / basename / suffix matching), not an unconfigured glob —
// every rule below is unit-tested against a fixture tree.

import { lstatSync, readdirSync, readlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── What may NOT be uploaded (everything else in `.forgeax` goes) ───────────

/** Path *segments* (matched against any component, at every depth) whose whole
 *  subtree is excluded — runtime state that regenerates itself. */
export const EXCLUDE_SEGMENTS: readonly string[] = [
  "logs",
  "debug",
  "node_modules",   // games/* may symlink to packages with node_modules — git chokes
  "cache",          // includes the upload staging scratch if it ever lands here
  "run",
  "run.lock",
  "sentinels",
  "playwright-mcp", // MCP browser cache, tens of MB of pure runtime garbage
  "chrome-webgpu-profile", // Chrome profile: hundreds of MB AND carries login state/cookies
];

/** Files excluded by exact basename — known runtime / secret-bearing files,
 *  plus the upload feature's own local bookkeeping. */
export const EXCLUDE_BASENAMES: readonly string[] = [
  ".DS_Store",
  "dev-stack.env",
  "extension-dev-ports.json",
  "plugin-dev-ports.json", // legacy name (pre ADR 0025 词汇清尾)
  "browser-localStorage.json", // regenerable UI state; a localStorage dump can hold auth tokens
  "keys.yaml",                 // cli-provider key registry (<projectRoot>/.forgeax/keys.yaml) — raw API keys
  "upload.json",
  "upload-log.jsonl",
];

/** Files excluded by suffix — secret carriers by convention. */
export const EXCLUDE_SUFFIXES: readonly string[] = [".env", ".key", ".pem"];

/** Default per-file size gate. Oversized files are skipped (and reported) so a
 *  fat cooked asset can't hard-reject the push (GitHub's 100MB limit). */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A directory whose basename is a rollback backup snapshot, e.g.
 *  `cow-level.bak-1781237317`. Matched as a directory-name predicate (not a glob)
 *  because these are the single largest excludable payload and glob dir-segment
 *  semantics are too subtle to bet on. */
export function isBackupDir(name: string): boolean {
  return /\.bak-\d+$/.test(name);
}

/** Should this posix RELATIVE path (under `.forgeax`) be excluded? The one
 *  predicate shared by the walk and any deny check. */
export function isExcluded(relPath: string): boolean {
  const segs = relPath.split("/").filter(Boolean);
  if (segs.length === 0) return false;
  for (const seg of segs) {
    if (EXCLUDE_SEGMENTS.includes(seg)) return true;
    if (isBackupDir(seg)) return true;
  }
  const base = segs[segs.length - 1]!;
  if (EXCLUDE_BASENAMES.includes(base)) return true;
  for (const suf of EXCLUDE_SUFFIXES) if (base.endsWith(suf)) return true;
  return false;
}

/** Is a top-level entry name uploadable? Everything except the deny rules. */
export function isIncludedRoot(name: string): boolean {
  return !isExcluded(name);
}

// ── Tree walk ────────────────────────────────────────────────────────────────

export interface UploadFile {
  abs: string;
  /** posix path relative to the source root (`.forgeax`). */
  rel: string;
  bytes: number;
}

export interface WalkResult {
  files: UploadFile[];
  /** Symlinks encountered and NOT followed. `.forgeax/games/<slug>` sample games
   *  are symlinks into the packages/games monorepo source — dereferencing them
   *  would push engine source to a public repo, so we skip and report. */
  skippedSymlinks: { rel: string; target: string }[];
  /** Files over the size gate — not uploaded. */
  skippedLarge: { rel: string; bytes: number }[];
  totalBytes: number;
}

export interface WalkOptions {
  maxFileBytes?: number;
}

/** Walk `<srcRoot>` (= `<projectRoot>/.forgeax`) collecting uploadable regular
 *  files — the whole directory minus the deny rules. Applies isExcluded at every
 *  depth; never follows symlinks; enforces the size gate. Pure filesystem read —
 *  no git, fully unit-testable against a fixture tree. */
export function walkUploadTree(srcRoot: string, opts: WalkOptions = {}): WalkResult {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const out: WalkResult = { files: [], skippedSymlinks: [], skippedLarge: [], totalBytes: 0 };

  let topEntries: string[];
  try {
    topEntries = readdirSync(srcRoot);
  } catch {
    return out; // no .forgeax → empty result (caller decides if that's an error)
  }

  for (const name of topEntries) {
    if (isExcluded(name)) continue;
    walk(join(srcRoot, name), name, out, maxBytes);
  }
  return out;
}

function walk(abs: string, rel: string, out: WalkResult, maxBytes: number): void {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return; // dangling entry — skip, keep enumerating siblings
  }

  if (st.isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(abs);
    } catch {
      /* ignore */
    }
    out.skippedSymlinks.push({ rel, target });
    return;
  }

  if (st.isDirectory()) {
    let children: string[];
    try {
      children = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of children) {
      const childRel = `${rel}/${name}`;
      if (isExcluded(childRel)) continue;
      walk(join(abs, name), childRel, out, maxBytes);
    }
    return;
  }

  if (st.isFile()) {
    if (st.size > maxBytes) {
      out.skippedLarge.push({ rel, bytes: st.size });
      return;
    }
    out.files.push({ abs, rel, bytes: st.size });
    out.totalBytes += st.size;
  }
}

// ── Fail-closed content secret scan ──────────────────────────────────────────

/** Patterns of common credential shapes. A filename denylist alone can't catch a
 *  key pasted INTO a souls/memory note or logged inline — this scans bytes. */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  // sk-ant- first-class: the sk- pattern below can't match it (hyphens break the
  // run), and the env-literal scan only covers THIS machine's key — a key pasted
  // into a souls memory / transcript is exactly what this gate exists for.
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "github-token", re: /gh[opsur]_[A-Za-z0-9]{36}/ }, // ghp_/gho_/ghu_/ghs_/ghr_
  { kind: "github-pat-fine", re: /github_pat_[A-Za-z0-9_]{40,}/ },
  { kind: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "private-key-pem", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: "jwt-bearer", re: /bearer\s+eyJ[A-Za-z0-9_-]{10,}/i },
];

export interface SecretHit {
  rel: string;
  kind: string;
}

/** Env vars whose literal values must never appear in an uploaded byte (the upload
 *  token itself + LLM keys). Returned values are filtered to non-trivial length so
 *  an empty/short env var can't match everything. */
export function sensitiveEnvLiterals(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = [
    "FORGEAX_UPLOAD_GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
  ];
  const out: string[] = [];
  for (const k of keys) {
    const v = env[k];
    if (v && v.trim().length >= 8) out.push(v.trim());
  }
  return out;
}

/** Scan one file's text for secret patterns + literal env-secret values. */
export function scanContentForSecrets(rel: string, content: string, literals: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(content)) hits.push({ rel, kind });
  }
  for (const lit of literals) {
    if (content.includes(lit)) hits.push({ rel, kind: "env-secret-literal" });
  }
  return hits;
}

/** Scan already-read bytes. Archive construction reuses this so every source file
 *  is read only once while still applying the same fail-closed policy. */
export function scanBufferForSecrets(rel: string, buf: Buffer, literals: string[]): SecretHit[] {
  if (looksBinary(buf)) return [];
  return scanContentForSecrets(rel, buf.toString("utf8"), literals);
}

/** Scan a set of files on disk. Skips files that look binary (NUL byte in the head)
 *  to avoid garbage matches; secrets are text by nature. Fail-closed: caller must
 *  abort the upload if the returned array is non-empty. */
export function scanFilesForSecrets(files: UploadFile[], literals: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(f.abs);
    } catch {
      continue;
    }
    hits.push(...scanBufferForSecrets(f.rel, buf, literals));
  }
  return hits;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
