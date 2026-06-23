/**
 * media-mime-sniff.ts — Detect media MIME by magic bytes, not by file extension.
 *
 * Why this exists: upstream producers (image generators, user uploads, file
 * extensions in general) routinely lie about file format. A `.png` that's
 * actually JPEG bytes will be sent to Anthropic's API with `media_type:
 * "image/png"` and rejected with HTTP 400. The fix is to ignore the declared
 * mime when the bytes themselves disagree.
 *
 * `sniffMediaMime` reads only the first ~16 bytes (no full decode), so the cost
 * is negligible compared to the LLM call that follows.
 *
 * Returns `null` for formats that have no reliable magic bytes (SVG, plain
 * text, JSON, CSV, etc.) — caller should fall back to whatever it had.
 */

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

function startsWith(buf: Buffer, offset: number, sig: readonly number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

// ISO Base Media File Format: bytes 4..8 == "ftyp", then 4-byte major brand at 8..12.
function readIsoBmffBrand(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (!startsWith(buf, 4, ASCII("ftyp"))) return null;
  return buf.subarray(8, 12).toString("ascii");
}

/**
 * Inspect the first few bytes of `buf` and return the corresponding canonical
 * MIME type, or `null` if the format is unrecognised. Recognises the common
 * formats that any of our LLM providers (Anthropic, OpenAI, Gemini) accepts:
 *
 * Images   : png, jpeg, gif, webp, bmp, heic/heif, avif
 * Documents: pdf
 * Audio    : mp3, wav, ogg, flac
 * Video    : mp4 (incl. m4a/m4v/mov), webm (matroska)
 */
export function sniffMediaMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;

  // ── Images ───────────────────────────────────────────────────────────
  if (startsWith(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, 0, ASCII("GIF87a")) || startsWith(buf, 0, ASCII("GIF89a"))) return "image/gif";
  if (startsWith(buf, 0, [0x42, 0x4d])) return "image/bmp";
  // RIFF containers: WEBP / WAV / AVI share the RIFF header — disambiguate by form type at offset 8.
  if (startsWith(buf, 0, ASCII("RIFF")) && buf.length >= 12) {
    const form = buf.subarray(8, 12).toString("ascii");
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
    if (form === "AVI ") return "video/x-msvideo";
  }

  // ── ISO Base Media File Format (HEIC / AVIF / MP4 / MOV / M4A …) ─────
  const brand = readIsoBmffBrand(buf);
  if (brand) {
    // HEIF/HEIC brands (still images): see ISO/IEC 23008-12.
    if (
      brand === "heic" || brand === "heix" || brand === "heim" || brand === "heis" ||
      brand === "hevc" || brand === "hevm" || brand === "hevs" ||
      brand === "mif1" || brand === "msf1"
    ) {
      return "image/heic";
    }
    // AVIF
    if (brand === "avif" || brand === "avis") return "image/avif";
    // Audio M4A / M4B
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    // QuickTime
    if (brand === "qt  ") return "video/quicktime";
    // Generic MP4 variants (incl. M4V, isom, iso2, mp41, mp42, dash, …)
    return "video/mp4";
  }

  // ── Documents ────────────────────────────────────────────────────────
  if (startsWith(buf, 0, ASCII("%PDF-"))) return "application/pdf";

  // ── Audio ────────────────────────────────────────────────────────────
  if (startsWith(buf, 0, ASCII("ID3"))) return "audio/mpeg";              // MP3 with ID3 tag
  if (startsWith(buf, 0, [0xff, 0xfb]) || startsWith(buf, 0, [0xff, 0xf3]) ||
      startsWith(buf, 0, [0xff, 0xf2])) return "audio/mpeg";              // MP3 frame sync
  if (startsWith(buf, 0, ASCII("OggS"))) return "audio/ogg";
  if (startsWith(buf, 0, ASCII("fLaC"))) return "audio/flac";

  // ── Video (Matroska / WebM) ─────────────────────────────────────────
  if (startsWith(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";

  return null;
}

/**
 * Reconcile `declaredMime` against magic-byte sniffing.
 *
 * If the bytes match a known format AND that format disagrees with what was
 * declared, return the sniffed mime and log a single warn so the source of the
 * lie can be traced. Otherwise return `declaredMime` unchanged.
 *
 * `label` is included in the warn line — typically a path or `"inline image"`.
 */
export function coerceMimeBySniff(bytes: Buffer, declaredMime: string, label: string): string {
  const sniffed = sniffMediaMime(bytes);
  if (!sniffed) return declaredMime;
  if (mimesEquivalent(sniffed, declaredMime)) return declaredMime;
  console.warn(
    `[media-mime] mismatch for ${label}: declared "${declaredMime}", sniffed "${sniffed}" — using sniffed`,
  );
  return sniffed;
}

// Some declared mimes are aliases of canonical ones; treat them as equivalent
// so we don't log spurious mismatches. Keep this list deliberately small.
function mimesEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (m: string) => {
    const lower = m.toLowerCase().trim();
    if (lower === "image/jpg") return "image/jpeg";
    if (lower === "image/pjpeg") return "image/jpeg";
    if (lower === "image/x-png") return "image/png";
    if (lower === "audio/x-wav" || lower === "audio/wave") return "audio/wav";
    if (lower === "audio/mp3") return "audio/mpeg";
    if (lower === "video/x-m4v") return "video/mp4";
    if (lower === "image/heif") return "image/heic";
    return lower;
  };
  return norm(a) === norm(b);
}
