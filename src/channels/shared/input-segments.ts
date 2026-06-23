/**
 * @desc Shared InputSegment type, manipulation helpers, and display functions
 *
 * ink-renderer/use-input-state.ts and other consumers
 * operate on InputSegment[]. This module centralizes the helpers so neither
 * side carries a copy.
 *
 * Cursor model:
 *   - text/paste segments: cursor length = content.length
 *   - file/media segments: cursor length = 1 (virtual slot for navigation)
 *   - segContent() returns only text/paste content (no virtual chars)
 */

import { basename } from "node:path";
import type { InputModality } from "../../core/types.js";

// ── InputSegment type (canonical definition) ──

export type InputSegment =
  | { type: "text" | "paste"; content: string }
  | { type: "file"; path: string; mimeType?: string; modality?: InputModality }
  | { type: "media"; data: string; mimeType: string; modality: InputModality };

// ── Length / content ──

/** Cursor-space length. file/media get a virtual slot of 1 for navigation. */
export function segLen(seg: InputSegment): number {
  if (seg.type === "text" || seg.type === "paste") return seg.content.length;
  return 1;
}

/** Extractable text content (file/media excluded — they carry data separately). */
export function segContent(segs: InputSegment[]): string {
  let out = "";
  for (const s of segs) {
    if (s.type === "text" || s.type === "paste") out += s.content;
  }
  return out;
}

export function totalLen(segs: InputSegment[]): number {
  let n = 0;
  for (const s of segs) n += segLen(s);
  return n;
}

export function cloneSegments(segs: InputSegment[]): InputSegment[] {
  return segs.map(s => ({ ...s }));
}

// ── Lookup ──

export interface SegmentHit {
  segIdx: number;
  segOffset: number;
  seg: InputSegment;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * If index lands inside a surrogate pair boundary, move to a safe boundary.
 * preferNext=true moves after the pair; false moves before the pair.
 */
function normalizeBoundaryIndex(s: string, index: number, preferNext = true): number {
  if (index <= 0 || index >= s.length) return index;
  const prev = s.charCodeAt(index - 1);
  const curr = s.charCodeAt(index);
  if (isHighSurrogate(prev) && isLowSurrogate(curr)) {
    return preferNext ? index + 1 : index - 1;
  }
  return index;
}

export function findSegmentAt(segs: InputSegment[], pos: number): SegmentHit | null {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const len = segLen(seg);
    if (pos >= offset && pos < offset + len) {
      return { segIdx: i, segOffset: offset, seg };
    }
    offset += len;
  }
  return null;
}

// ── Mutation (in-place) ──

export function insertAt(segs: InputSegment[], pos: number, ch: string): void {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const len = segLen(seg);
    if (pos >= offset && pos <= offset + len) {
      if (seg.type === "text") {
        const rel = normalizeBoundaryIndex(seg.content, pos - offset, true);
        seg.content = seg.content.slice(0, rel) + ch + seg.content.slice(rel);
        return;
      } else if (pos === offset) {
        // Insert before this non-text segment
        segs.splice(i, 0, { type: "text", content: ch });
        return;
      } else {
        // pos > offset: insert after this segment
        offset += len;
        continue;
      }
    }
    offset += len;
  }
  const last = segs.at(-1);
  if (last?.type === "text") { last.content += ch; }
  else { segs.push({ type: "text", content: ch }); }
}

export function deleteAt(segs: InputSegment[], pos: number): void {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const len = segLen(seg);
    if (pos >= offset && pos < offset + len) {
      if (seg.type === "file" || seg.type === "media") {
        segs.splice(i, 1);
        return;
      }
      if (seg.type !== "text" && seg.type !== "paste") return;
      const rel = pos - offset;
      const code = seg.content.charCodeAt(rel);
      if (Number.isNaN(code)) return;
      // Delete full surrogate pair as a single logical character.
      if (
        isHighSurrogate(code) &&
        rel + 1 < seg.content.length &&
        isLowSurrogate(seg.content.charCodeAt(rel + 1))
      ) {
        seg.content = seg.content.slice(0, rel) + seg.content.slice(rel + 2);
      } else if (
        isLowSurrogate(code) &&
        rel > 0 &&
        isHighSurrogate(seg.content.charCodeAt(rel - 1))
      ) {
        seg.content = seg.content.slice(0, rel - 1) + seg.content.slice(rel + 1);
      } else {
        seg.content = seg.content.slice(0, rel) + seg.content.slice(rel + 1);
      }
      if (seg.content.length === 0) segs.splice(i, 1);
      return;
    }
    offset += len;
  }
}

export function insertSegmentAt(
  segs: InputSegment[], pos: number, text: string,
  type: "text" | "paste" = "paste",
): void {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const len = segLen(seg);
    if (pos >= offset && pos <= offset + len) {
      if (seg.type === "text") {
        const rel = normalizeBoundaryIndex(seg.content, pos - offset, true);
        if (type === "text") {
          seg.content = seg.content.slice(0, rel) + text + seg.content.slice(rel);
        } else {
          const before = seg.content.slice(0, rel);
          const after = seg.content.slice(rel);
          const newSegs: InputSegment[] = [];
          if (before) newSegs.push({ type: "text", content: before });
          newSegs.push({ type, content: text });
          if (after) newSegs.push({ type: "text", content: after });
          segs.splice(i, 1, ...newSegs);
        }
        return;
      } else if (pos === offset) {
        segs.splice(i, 0, { type, content: text });
        return;
      } else {
        offset += len;
        continue;
      }
    }
    offset += len;
  }
  const last = segs.at(-1);
  if (type === "text" && last?.type === "text") {
    last.content += text;
  } else {
    segs.push({ type, content: text });
  }
}

export const insertPasteAt = insertSegmentAt;

// ── Display labels ──

export function segmentLabel(seg: InputSegment): string {
  if (seg.type === "paste") {
    const n = seg.content.split("\n").length;
    return `[已粘贴 ${n} 行]`;
  }
  if (seg.type === "file") return `[附件: ${basename(seg.path)}]`;
  if (seg.type === "media") return `[${seg.modality}: ${seg.mimeType}]`;
  return "";
}

/**
 * ANSI string for visual_display. Terminals render directly;
 * non-terminal channels can strip ANSI to get plain text.
 */
export function segmentsToVisualDisplay(segments: InputSegment[]): string {
  let display = "";
  for (const seg of segments) {
    if (seg.type === "paste") {
      const lines = seg.content.split("\n").length;
      display += `\x1b[44;97m[已粘贴 ${lines} 行]\x1b[0m`;
    } else if (seg.type === "file") {
      display += `\x1b[46;30m[附件: ${basename(seg.path)}]\x1b[0m`;
    } else if (seg.type === "media") {
      display += `\x1b[45;97m[${seg.modality}: ${seg.mimeType}]\x1b[0m`;
    } else {
      display += seg.content;
    }
  }
  return display;
}
