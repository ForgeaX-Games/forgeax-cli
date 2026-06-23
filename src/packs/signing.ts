/**
 * Phase D7 — `.fxpack` ed25519 signing + verification.
 *
 * Spec: 10-FXPACK-PORTABILITY §4. The pack carries a `signature.json` at the
 * staging root with:
 *   { algorithm: "ed25519", publicKey, signedAt, signature, files: {<rel>: "sha256:..."} }
 *
 * The `signature` is an ed25519 signature over the canonical UTF-8 JSON
 * encoding of `{algorithm, publicKey, signedAt, files}` with object keys
 * sorted ascending. Receivers recompute the digest map by re-walking the
 * staging dir, drop entries that don't match, and verify the signature using
 * the embedded public key.
 *
 * Verification doesn't decide trust — it answers "are these bytes from the
 * holder of <publicKey>". Trust is layered on top via plugins-trust.yaml +
 * the user's ~/.forgeax/trusted-keys.yaml (a future patch — out of scope
 * here). The unsigned-pack path is still allowed; this module only kicks in
 * when the caller passes a key, or the importer finds a `signature.json`.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SignatureFile {
  algorithm: 'ed25519';
  publicKey: string;
  signedAt: string;
  signature: string;
  files: Record<string, string>;
}

/** Walk a staging directory, returning UNIX-style relative paths. Skips
 *  signature.json (it's the artefact being produced/consumed). */
function walk(root: string, base = root, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (entry !== 'signature.json') out.push(abs.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

function sha256OfFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Canonical JSON with sorted keys at every level — input to the signature. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/** Compute the file→sha256 map for a staging dir. */
function fileDigests(stagingDir: string): Record<string, string> {
  const files = walk(stagingDir);
  files.sort();
  const out: Record<string, string> = {};
  for (const rel of files) out[rel] = sha256OfFile(join(stagingDir, rel));
  return out;
}

export interface SignInput {
  /** PEM-encoded ed25519 private key (PKCS8). */
  privateKey: string;
  /** PEM-encoded ed25519 public key (SPKI). Embedded in the signature. */
  publicKey: string;
  /** Wall-clock signedAt. Defaults to `new Date().toISOString()`. */
  signedAt?: string;
}

/** Build + write `signature.json` into stagingDir. Returns the signature file. */
export function signStaging(stagingDir: string, input: SignInput): SignatureFile {
  const sigPath = join(stagingDir, 'signature.json');
  if (existsSync(sigPath)) {
    // Don't include a stale signature in its own digest map.
    throw Object.assign(new Error('signature.json already exists in staging'), { code: 'bad_input' });
  }
  const files = fileDigests(stagingDir);
  const signedAt = input.signedAt ?? new Date().toISOString();
  const payload = canonicalize({
    algorithm: 'ed25519',
    publicKey: input.publicKey,
    signedAt,
    files,
  });
  const key = createPrivateKey(input.privateKey);
  const sigBuf = nodeSign(null, Buffer.from(payload, 'utf-8'), key);
  const sig: SignatureFile = {
    algorithm: 'ed25519',
    publicKey: input.publicKey,
    signedAt,
    signature: sigBuf.toString('base64'),
    files,
  };
  writeFileSync(sigPath, JSON.stringify(sig, null, 2), 'utf-8');
  return sig;
}

export interface VerifyResult {
  ok: boolean;
  signed: boolean;
  /** Public key found in signature.json, even if verification failed. */
  publicKey?: string;
  /** Reason when ok=false. */
  reason?: 'no_signature' | 'malformed' | 'digest_mismatch' | 'signature_invalid' | 'extra_files' | 'missing_files';
  /** When digest_mismatch / extra_files / missing_files, the offending paths. */
  detail?: string[];
}

/** Verify `signature.json` against the contents of `stagingDir`. */
export function verifyStaging(stagingDir: string): VerifyResult {
  const sigPath = join(stagingDir, 'signature.json');
  if (!existsSync(sigPath)) return { ok: false, signed: false, reason: 'no_signature' };
  let sig: SignatureFile;
  try {
    sig = JSON.parse(readFileSync(sigPath, 'utf-8')) as SignatureFile;
  } catch {
    return { ok: false, signed: true, reason: 'malformed' };
  }
  if (sig.algorithm !== 'ed25519' || typeof sig.publicKey !== 'string' || typeof sig.signature !== 'string' || typeof sig.signedAt !== 'string' || !sig.files || typeof sig.files !== 'object') {
    return { ok: false, signed: true, reason: 'malformed', publicKey: sig.publicKey };
  }

  // Re-walk the staging dir; compare against signature's `files` map.
  const observed = fileDigests(stagingDir);
  const obsKeys = new Set(Object.keys(observed));
  const sigKeys = new Set(Object.keys(sig.files));
  const missing: string[] = [];
  const extra: string[] = [];
  const mismatch: string[] = [];
  for (const k of sigKeys) if (!obsKeys.has(k)) missing.push(k);
  for (const k of obsKeys) if (!sigKeys.has(k)) extra.push(k);
  for (const k of sigKeys) if (obsKeys.has(k) && observed[k] !== sig.files[k]) mismatch.push(k);
  if (missing.length) return { ok: false, signed: true, publicKey: sig.publicKey, reason: 'missing_files', detail: missing };
  if (extra.length) return { ok: false, signed: true, publicKey: sig.publicKey, reason: 'extra_files', detail: extra };
  if (mismatch.length) return { ok: false, signed: true, publicKey: sig.publicKey, reason: 'digest_mismatch', detail: mismatch };

  const payload = canonicalize({
    algorithm: 'ed25519',
    publicKey: sig.publicKey,
    signedAt: sig.signedAt,
    files: sig.files,
  });
  let pub;
  try {
    pub = createPublicKey(sig.publicKey);
  } catch {
    return { ok: false, signed: true, publicKey: sig.publicKey, reason: 'malformed' };
  }
  const ok = nodeVerify(null, Buffer.from(payload, 'utf-8'), pub, Buffer.from(sig.signature, 'base64'));
  if (!ok) return { ok: false, signed: true, publicKey: sig.publicKey, reason: 'signature_invalid' };
  return { ok: true, signed: true, publicKey: sig.publicKey };
}
