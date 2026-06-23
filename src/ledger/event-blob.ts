/** event-blob —— 通用大值外置（>64KB 字符串 → `event-ledger.blobs/<sha256>.bin`）。
 *
 *  与 agenteam ref 1:1 复刻；只改两处：
 *  - blobs 目录名 `medias/` → `event-ledger.blobs/`（plan §1 / fs/types AgentLayerAPI 已对齐）
 *  - 该目录由 caller (event-ledger.ts) 通过 PathManager 解析后传入；这里只做 I/O
 *
 *  策略：
 *  - sentinel 形如 `{__ledger_blob__: true, sha256, enc, len}`；isLedgerBlob 严格 4
 *    字段校验，外部数据载入 sentinel-shaped object 一律降级（不递归不复活）。
 *  - 写时 detectEncoding：base64 magic / 严格 charset → "base64"；其余走 "utf8"。
 *  - 读时 walkAndReinflate：strict guard 通过则 loadBlob，文件缺失抛
 *    LedgerBlobMissingError（pa renderer 不传 blobsDir 就不会触发 reinflate）。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ─── Constants ──────────────────────────────────────────────────

export const LARGE_VALUE_THRESHOLD = 64 * 1024;
export const LEDGER_BLOB_KEY = "__ledger_blob__";

// ─── Types ──────────────────────────────────────────────────────

export interface LedgerBlob {
  readonly __ledger_blob__: true;
  readonly sha256: string;
  readonly enc: "base64" | "utf8";
  readonly len: number;
}

export class LedgerBlobMissingError extends Error {
  constructor(public readonly sha256: string, hint?: string) {
    super(`event-blob: missing event-ledger.blobs/${sha256}.bin${hint ? ` (${hint})` : ""}`);
    this.name = "LedgerBlobMissingError";
  }
}

// ─── Type guard ─────────────────────────────────────────────────

/** 严格 4 字段校验；任何形状偏差都视为「非框架 sentinel」走降级路径。 */
export function isLedgerBlob(v: unknown): v is LedgerBlob {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o[LEDGER_BLOB_KEY] !== true) return false;
  if (typeof o.sha256 !== "string" || !/^[a-f0-9]{16}$/.test(o.sha256)) return false;
  if (o.enc !== "base64" && o.enc !== "utf8") return false;
  if (typeof o.len !== "number" || !Number.isFinite(o.len) || o.len <= 0 || o.len > 1e9) return false;
  if (Object.keys(o).length !== 4) return false;
  return true;
}

// ─── Encoding detection ────────────────────────────────────────

const BASE64_IMAGE_MAGICS = ["iVBORw0KGgo", "/9j/4", "UklGR"] as const;
const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function detectEncoding(value: string): "base64" | "utf8" {
  for (const magic of BASE64_IMAGE_MAGICS) {
    if (value.startsWith(magic)) return "base64";
  }
  if (value.length >= 4 && value.length % 4 === 0 && BASE64_STRICT_RE.test(value)) {
    return "base64";
  }
  return "utf8";
}

// ─── Disk I/O ──────────────────────────────────────────────────

function blobPath(sha256: string, blobsDir: string): string {
  return join(blobsDir, `${sha256}.bin`);
}

export function persistBlob(rawBytes: Buffer, blobsDir: string): { sha256: string } {
  const fullHex = createHash("sha256").update(rawBytes).digest("hex");
  const sha256 = fullHex.slice(0, 16);
  const path = blobPath(sha256, blobsDir);
  if (!existsSync(path)) {
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(path, rawBytes);
  }
  return { sha256 };
}

export function loadBlob(sha256: string, blobsDir: string, hint?: string): Buffer {
  const path = blobPath(sha256, blobsDir);
  if (!existsSync(path)) {
    throw new LedgerBlobMissingError(sha256, hint);
  }
  return readFileSync(path);
}

// ─── Walk: externalize (write-time) ────────────────────────────

/** 递归遍历 node，把 length>threshold 的字符串值替换为 sentinel obj，原地修改。
 *  Caller 必须传入 deep clone（EventLedger.append 用 structuredClone）。 */
export function walkAndExternalize(
  node: unknown,
  blobsDir: string,
  threshold: number = LARGE_VALUE_THRESHOLD,
): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string" && v.length > threshold) {
        const sentinel = tryExternalizeString(v, blobsDir);
        if (sentinel) node[i] = sentinel;
      } else {
        walkAndExternalize(v, blobsDir, threshold);
      }
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > threshold) {
      const sentinel = tryExternalizeString(v, blobsDir);
      if (sentinel) obj[key] = sentinel;
    } else {
      walkAndExternalize(v, blobsDir, threshold);
    }
  }
}

function tryExternalizeString(value: string, blobsDir: string): LedgerBlob | null {
  try {
    const enc = detectEncoding(value);
    const bytes = enc === "base64"
      ? Buffer.from(value, "base64")
      : Buffer.from(value, "utf8");
    const { sha256 } = persistBlob(bytes, blobsDir);
    return { __ledger_blob__: true, sha256, enc, len: value.length };
  } catch (err) {
    // Persist 失败 → 留 inline，WAL 仍合法（degrade 而不是 break）。
    process.stderr.write(`[event-blob] persist failed, keeping value inline: ${(err as Error).message}\n`);
    return null;
  }
}

// ─── Walk: reinflate (read-time) ───────────────────────────────

/** 递归遍历 + 反向复活。三层防注入：
 *    1. isLedgerBlob 严格 type guard
 *    2. 形状不符 → 留原对象 + warn，不递归子节点
 *    3. 文件缺失 → 抛 LedgerBlobMissingError（caller 决定是否降级） */
export function walkAndReinflate(node: unknown, blobsDir: string): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (looksLikeSentinel(v)) {
        if (isLedgerBlob(v)) {
          node[i] = reinflateOne(v, blobsDir);
        } else {
          warnSuspicious(v);
        }
      } else {
        walkAndReinflate(v, blobsDir);
      }
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (looksLikeSentinel(v)) {
      if (isLedgerBlob(v)) {
        obj[key] = reinflateOne(v, blobsDir);
      } else {
        warnSuspicious(v);
      }
    } else {
      walkAndReinflate(v, blobsDir);
    }
  }
}

function looksLikeSentinel(v: unknown): boolean {
  return !!v
    && typeof v === "object"
    && (v as Record<string, unknown>)[LEDGER_BLOB_KEY] === true;
}

function reinflateOne(blob: LedgerBlob, blobsDir: string): string {
  const bytes = loadBlob(blob.sha256, blobsDir, `len=${blob.len} enc=${blob.enc}`);
  return blob.enc === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
}

function warnSuspicious(v: unknown): void {
  const keys = v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : [];
  process.stderr.write(
    `[event-blob] sentinel-shaped object failed strict type guard, refusing to reinflate (keys=${keys.join(",")})\n`,
  );
}
