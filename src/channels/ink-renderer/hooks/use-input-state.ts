/**
 * useInputState — segment-based text editor state for InputBox.
 *
 * Internal model uses InputSegment[] (text | paste | file | media) instead of a
 * flat string, enabling atomic operations on paste blocks and zero-length
 * file/media attachments.
 *
 * Features:
 *   - Cursor navigation: arrows, Ctrl+A/E (start/end), Home/End
 *   - History: ↑/↓ browse
 *   - Multi-line: Shift+Enter / Alt+Enter / backslash+Enter
 *   - Kill ring: Ctrl+U (to start), Ctrl+K (to end), Ctrl+W (word), Ctrl+Y (yank)
 *   - Bracketed paste: isPasted → creates atomic paste segment
 *   - File/media attachments: zero-length segments appended at end
 *   - Word navigation: Ctrl+Left/Right
 *   - Atomic paste block: cursor skips, backspace deletes whole block
 *
 * Performance:
 *   - State is a single reducer-driven object so each keypress produces one
 *     commit (no torn intermediate state between segments/cursor).
 *   - Fast path: typing a single printable character at the end of input
 *     skips cloneSegments; the hot path allocates only the replacement tail.
 */

import { useCallback, useReducer, useRef } from "react";
import type { Key, InputEvent } from "../ink/events/input-event.js";
import type { InputSegment } from "../types.js";
import { parseTextAsFileSegments } from "../lib/file-reference-parser.js";
import { pullSystemMedia } from "../lib/system-media-ingress.js";
import {
  segLen, segContent, totalLen, cloneSegments,
  findSegmentAt, insertAt, deleteAt, insertPasteAt, insertSegmentAt,
} from "../../shared/input-segments.js";
import { pushKill, getLastKill } from "./kill-ring.js";

const MAX_HISTORY = 100;

// ── Exported types ──

export interface InputStateResult {
  text: string;
  segments: InputSegment[];
  cursorPos: number;
  isMultiline: boolean;
  handleInput: (input: string, key: Key, event?: InputEvent) => void;
  setText: (t: string) => void;
  /**
   * Imperative replace — used by draft restoration. Cursor lands at the end
   * of the new content; history index is reset.
   */
  setSegments: (segs: InputSegment[]) => void;
  /** Imperative cursor positioning (clamped). Used by InputBox.onKeyDown. */
  setCursor: (pos: number) => void;
  clear: () => void;
}

interface UseInputStateOptions {
  onSubmit: (text: string, segments: InputSegment[]) => void;
  onSteerSubmit?: (text: string, segments: InputSegment[]) => void;
  onSlashCommand?: (command: string) => void;
  onAttachment?: (paths: string[]) => void;
}

// ── Reducer state ──
// Single object keeps segments + cursor in sync and yields one React commit
// per dispatch; double setState had the same result under React 18 batching
// but cost an extra scheduled update per keystroke.

interface InternalState {
  segments: InputSegment[];
  cursor: number;
}

type InputAction = { type: "set"; next: InternalState };

function reducer(state: InternalState, action: InputAction): InternalState {
  switch (action.type) {
    case "set":
      if (state.segments === action.next.segments && state.cursor === action.next.cursor) {
        return state;
      }
      return action.next;
    default:
      return state;
  }
}

const INITIAL_STATE: InternalState = { segments: [], cursor: 0 };

export function useInputState({
  onSubmit,
  onSteerSubmit,
  onSlashCommand,
  onAttachment,
}: UseInputStateOptions): InputStateResult {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const { segments, cursor: cursorPos } = state;

  const segsRef = useRef(segments);
  segsRef.current = segments;
  const cursorRef = useRef(cursorPos);
  cursorRef.current = cursorPos;

  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const draftRef = useRef("");
  const lastYankRef = useRef<{ start: number; len: number } | null>(null);

  const update = useCallback((segs: InputSegment[], cursor: number) => {
    dispatch({ type: "set", next: { segments: segs, cursor } });
  }, []);

  const pushHistory = useCallback((entry: string) => {
    const h = historyRef.current;
    if (h.length > 0 && h[h.length - 1] === entry) return;
    h.push(entry);
    if (h.length > MAX_HISTORY) h.shift();
    historyIdxRef.current = -1;
    draftRef.current = "";
  }, []);

  const clear = useCallback(() => {
    update([], 0);
    historyIdxRef.current = -1;
  }, [update]);

  const setText = useCallback((t: string) => {
    const segs: InputSegment[] = t ? [{ type: "text", content: t }] : [];
    update(segs, Array.from(t).length);
    historyIdxRef.current = -1;
  }, [update]);

  const setSegments = useCallback((segs: InputSegment[]) => {
    update(segs, totalLen(segs));
    historyIdxRef.current = -1;
  }, [update]);

  const setCursor = useCallback((pos: number) => {
    const max = totalLen(segsRef.current);
    const clamped = Math.max(0, Math.min(pos, max));
    update(segsRef.current, clamped);
  }, [update]);

  const handleInput = useCallback((input: string, key: Key, event?: InputEvent) => {
    const isPasted = !!(event?.keypress?.isPasted);

    /**
     * Shared async path for multi-character input (bracketed paste or IDE drag).
     * Tries file path detection first; falls back to paste-block or plain text.
     */
    const BATCH_PASTE_THRESHOLD = 200;

    const ingestBatch = (normalized: string) => {
      if (normalized.length > BATCH_PASTE_THRESHOLD) {
        const s = cloneSegments(segsRef.current);
        insertPasteAt(s, cursorRef.current, normalized);
        update(s, cursorRef.current + normalized.length);
        return;
      }

      const fallback = () => {
        const s = cloneSegments(segsRef.current);
        const pos = cursorRef.current;
        if (normalized.includes("\n")) {
          insertPasteAt(s, pos, normalized);
        } else {
          insertSegmentAt(s, pos, normalized, "text");
        }
        update(s, pos + normalized.length);
      };
      parseTextAsFileSegments(normalized).then(fileSegs => {
        if (fileSegs && fileSegs.length > 0) {
          const s = cloneSegments(segsRef.current);
          s.push(...fileSegs);
          update(s, cursorRef.current + fileSegs.length);
        } else {
          fallback();
        }
      }).catch(fallback);
    };

    // ── Bracketed paste ──
    if (isPasted && input.length > 0) {
      ingestBatch(input.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      historyIdxRef.current = -1;
      return;
    }

    // ── Empty paste (Ctrl+V with no text) → try clipboard media ──
    if (isPasted && input.length === 0) {
      pullSystemMedia().then(result => {
        if (result.kind === "ok" && result.segments.length > 0) {
          const s = cloneSegments(segsRef.current);
          s.push(...result.segments);
          update(s, cursorRef.current + result.segments.length);
        }
      }).catch(() => {});
      return;
    }

    // ── FAST PATH: single printable char appended at end of input ──
    // The overwhelmingly common case during typing. Skips cloneSegments and
    // per-char insertAt by producing a minimal new segments array inline.
    if (
      input.length === 1 &&
      input !== "\n" && input !== "\r" &&
      !key.ctrl && !key.meta && !key.return && !key.escape &&
      !key.backspace && !key.delete && !key.tab &&
      !key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow &&
      !key.home && !key.end && !key.pageUp && !key.pageDown &&
      !key.wheelUp && !key.wheelDown
    ) {
      const prev = segsRef.current;
      const cp = cursorRef.current;
      if (cp === totalLen(prev)) {
        const last = prev.length > 0 ? prev[prev.length - 1]! : null;
        let next: InputSegment[];
        if (last && last.type === "text") {
          next = prev.slice(0, -1);
          next.push({ type: "text", content: last.content + input });
        } else {
          next = prev.length === 0
            ? [{ type: "text", content: input }]
            : [...prev, { type: "text", content: input }];
        }
        update(next, cp + 1);
        historyIdxRef.current = -1;
        lastYankRef.current = null;
        return;
      }
      // Fall through to slow path for mid-string insertion.
    }

    // ── Slow path: clone segments and mutate imperatively ──
    const segs = cloneSegments(segsRef.current);
    let cp = cursorRef.current;
    const text = () => segContent(segs);

    // ── Ctrl+Enter: steer submit ──
    if (key.return && key.ctrl && onSteerSubmit) {
      const t = text();
      const trimmed = t.trim();
      const hasFiles = segs.some(s => s.type === "file" || s.type === "media");
      if (!trimmed && !hasFiles) return;
      pushHistory(trimmed);
      onSteerSubmit(trimmed, segs);
      update([], 0);
      return;
    }

    // ── Ctrl+\: steer submit (fallback for terminals without extended keys) ──
    if (key.ctrl && input === "\\" && onSteerSubmit) {
      const t = text();
      const trimmed = t.trim();
      const hasFiles = segs.some(s => s.type === "file" || s.type === "media");
      if (!trimmed && !hasFiles) return;
      pushHistory(trimmed);
      onSteerSubmit(trimmed, segs);
      update([], 0);
      return;
    }

    // ── Shift+Enter / Alt+Enter: newline ──
    if (key.return && (key.shift || key.meta)) {
      insertAt(segs, cp, "\n");
      update(segs, cp + 1);
      return;
    }

    // Backslash+Enter: insert newline
    if (key.return && cp > 0) {
      const t = text();
      const chars = Array.from(t);
      if (chars[cp - 1] === "\\") {
        deleteAt(segs, cp - 1);
        insertAt(segs, cp - 1, "\n");
        update(segs, cp);
        return;
      }
    }

    // ── Enter: submit ──
    if (key.return) {
      const t = text();
      const trimmed = t.trim();
      const hasFiles = segs.some(s => s.type === "file" || s.type === "media");
      if (!trimmed && !hasFiles) return;
      pushHistory(trimmed);
      if (trimmed.startsWith("/") && !hasFiles && onSlashCommand) {
        onSlashCommand(trimmed);
      } else {
        onSubmit(trimmed, segs);
      }
      update([], 0);
      return;
    }

    // ── Kill ring operations ──
    if (input === "u" && key.ctrl) {
      const t = text();
      const chars = Array.from(t);
      const killed = chars.slice(0, cp).join("");
      if (killed) {
        pushKill(killed);
        // Rebuild segments: delete chars 0..cp
        let remaining = cp;
        while (remaining > 0 && segs.length > 0) {
          const seg = segs[0]!;
          const len = segLen(seg);
          if (len === 0) { segs.shift(); continue; }
          if (remaining >= len) {
            segs.shift();
            remaining -= len;
          } else {
            if (seg.type === "text" || seg.type === "paste") {
              seg.content = seg.content.slice(remaining);
            }
            remaining = 0;
          }
        }
      }
      update(segs, 0);
      lastYankRef.current = null;
      return;
    }

    if (input === "k" && key.ctrl) {
      const t = text();
      const chars = Array.from(t);
      const killed = chars.slice(cp).join("");
      if (killed) {
        pushKill(killed);
        // Rebuild: keep only chars 0..cp
        let kept = 0;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i]!;
          const len = segLen(seg);
          if (len === 0) continue;
          if (kept + len <= cp) { kept += len; continue; }
          const keep = cp - kept;
          if (seg.type === "text" || seg.type === "paste") {
            seg.content = seg.content.slice(0, keep);
            if (seg.content.length === 0) { segs.splice(i, 1); i--; }
          }
          // Remove all remaining text/paste segments after this
          for (let j = segs.length - 1; j > i; j--) {
            if (segLen(segs[j]!) > 0) segs.splice(j, 1);
          }
          break;
        }
      }
      update(segs, cp);
      lastYankRef.current = null;
      return;
    }

    if (input === "w" && key.ctrl) {
      const t = text();
      const chars = Array.from(t);
      let i = cp - 1;
      while (i >= 0 && /\s/.test(chars[i]!)) i--;
      while (i >= 0 && !/\s/.test(chars[i]!)) i--;
      i++;
      const killed = chars.slice(i, cp).join("");
      if (killed) {
        pushKill(killed);
        let remaining = cp - i;
        const pos = i;
        // Delete 'remaining' chars starting at pos
        let offset = 0;
        for (let si = 0; si < segs.length && remaining > 0; si++) {
          const seg = segs[si]!;
          const len = segLen(seg);
          if (len === 0) continue;
          if (offset + len <= pos) { offset += len; continue; }
          const start = Math.max(0, pos - offset);
          const end = Math.min(len, start + remaining);
          const delCount = end - start;
          if (seg.type === "text" || seg.type === "paste") {
            seg.content = seg.content.slice(0, start) + seg.content.slice(end);
            if (seg.content.length === 0) { segs.splice(si, 1); si--; }
          }
          remaining -= delCount;
          offset += len - delCount;
        }
      }
      update(segs, i);
      lastYankRef.current = null;
      return;
    }

    if (input === "y" && key.ctrl) {
      const yanked = getLastKill();
      if (yanked) {
        const yankChars = Array.from(yanked);
        for (const ch of yankChars) {
          insertAt(segs, cp, ch);
          cp++;
        }
        lastYankRef.current = { start: cp - yankChars.length, len: yankChars.length };
        update(segs, cp);
      } else {
        pullSystemMedia().then(result => {
          if (result.kind === "ok" && result.segments.length > 0) {
            const s = cloneSegments(segsRef.current);
            s.push(...result.segments);
            update(s, cursorRef.current + result.segments.length);
          }
        }).catch(() => {});
      }
      return;
    }

    // ── Cursor movement ──
    // Home/End live on Box.onKeyDown (focus-routed). See InputBox/HistoryLayer.
    if (input === "a" && key.ctrl) { update(segs, 0); return; }
    if (input === "e" && key.ctrl) { update(segs, totalLen(segs)); return; }

    if (key.leftArrow && key.ctrl) {
      const chars = Array.from(text());
      let i = cp - 1;
      while (i >= 0 && /\s/.test(chars[i]!)) i--;
      while (i >= 0 && !/\s/.test(chars[i]!)) i--;
      update(segs, Math.max(0, i + 1));
      return;
    }

    if (key.rightArrow && key.ctrl) {
      const chars = Array.from(text());
      let i = cp;
      while (i < chars.length && !/\s/.test(chars[i]!)) i++;
      while (i < chars.length && /\s/.test(chars[i]!)) i++;
      update(segs, i);
      return;
    }

    // ── Backspace — atomic block delete for paste/file/media ──
    if (key.backspace || key.delete) {
      if (cp === 0) return;
      const found = findSegmentAt(segs, cp - 1);
      if (found && found.seg.type !== "text") {
        segs.splice(found.segIdx, 1);
        update(segs, found.segOffset);
      } else {
        deleteAt(segs, cp - 1);
        update(segs, cp - 1);
      }
      return;
    }

    // ── Left/Right — atomic skip for paste/file/media ──
    if (key.leftArrow) {
      if (cp === 0) return;
      const found = findSegmentAt(segs, cp - 1);
      if (found && found.seg.type !== "text") {
        update(segs, found.segOffset);
      } else {
        update(segs, cp - 1);
      }
      return;
    }
    if (key.rightArrow) {
      if (cp >= totalLen(segs)) return;
      const found = findSegmentAt(segs, cp);
      if (found && found.seg.type !== "text") {
        update(segs, found.segOffset + segLen(found.seg));
      } else {
        update(segs, cp + 1);
      }
      return;
    }

    // ── History ──
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      if (historyIdxRef.current === -1) {
        draftRef.current = text();
        historyIdxRef.current = h.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current--;
      }
      const entry = h[historyIdxRef.current]!;
      const newSegs: InputSegment[] = entry ? [{ type: "text", content: entry }] : [];
      update(newSegs, Array.from(entry).length);
      return;
    }

    if (key.downArrow) {
      const h = historyRef.current;
      if (historyIdxRef.current === -1) return;
      if (historyIdxRef.current < h.length - 1) {
        historyIdxRef.current++;
        const entry = h[historyIdxRef.current]!;
        const newSegs: InputSegment[] = entry ? [{ type: "text", content: entry }] : [];
        update(newSegs, Array.from(entry).length);
      } else {
        historyIdxRef.current = -1;
        const draft = draftRef.current;
        const newSegs: InputSegment[] = draft ? [{ type: "text", content: draft }] : [];
        update(newSegs, Array.from(draft).length);
      }
      return;
    }

    if (key.ctrl || key.escape) return;
    if (key.pageUp || key.pageDown || key.wheelUp || key.wheelDown || key.tab) return;
    if (key.home || key.end) return; // handled on Box.onKeyDown — avoid double-fire

    // ── Character input (slow path: mid-string insertion / multi-char burst) ──
    if (input) {
      const normalized = input.length > 1 ? input.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : input;

      // Batch input (>1 char): drag-and-drop or IME burst — delegate to ingestBatch
      if (normalized.length > 1) {
        ingestBatch(normalized);
        historyIdxRef.current = -1;
        return;
      }

      for (const ch of Array.from(normalized)) {
        insertAt(segs, cp, ch);
        cp++;
      }
      update(segs, cp);
      historyIdxRef.current = -1;
    }
  }, [onSubmit, onSteerSubmit, onSlashCommand, onAttachment, pushHistory, update]);

  const text = segContent(segments);
  const isMultiline = text.includes("\n") || segments.some(s => s.type === "paste" && s.content.includes("\n"));

  return { text, segments, cursorPos, isMultiline, handleInput, setText, setSegments, setCursor, clear };
}
