/** @desc Inline media persistence and StoredEvent type */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let _mediasDir: string | null = null;

export function setMediasDir(dir: string): void {
  _mediasDir = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
  "video/mp4": "mp4", "video/webm": "webm",
};

export function saveInlineMedia(data: string, mimeType: string): string | null {
  if (!_mediasDir) return null;
  const ext = MIME_EXT[mimeType] ?? mimeType.split("/")[1] ?? "bin";
  const filename = `${randomUUID().slice(0, 12)}.${ext}`;
  const filePath = join(_mediasDir, filename);
  writeFileSync(filePath, Buffer.from(data, "base64"));
  return filePath;
}

/**
 * Persisted form of a bus Event. `emitterId` is the emitter agent captured by
 * EventBus at emit() time. Ledger owner is implied by file path
 * (`sessions/{id}/...`) — not stored on each event.
 */
export interface StoredEvent {
  type: string;
  ts: number;
  source?: string;
  to?: string;
  /** Emitter agent id captured by EventBus at emit() time. May be absent for non-routed events. */
  emitterId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseStoredEvent(line: string): StoredEvent | null {
  try {
    const rec = JSON.parse(line) as StoredEvent;
    if (typeof rec.type !== "string") return null;
    return rec;
  } catch { return null; }
}
