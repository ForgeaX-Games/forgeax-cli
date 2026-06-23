/** @desc ANSI escape codes and cursor helpers */

import * as readline from "node:readline";

export const C = {
  reset:   "\x1b[0m",
  dim:     "\x1b[90m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  yellow:  "\x1b[33m",
  bold:    "\x1b[1m",
} as const;

// ─── Cursor movement (all operate on process.stdout) ───

export function cursorUp(n: number): void {
  if (n > 0) readline.moveCursor(process.stdout, 0, -n);
}
export function cursorDown(n: number): void {
  if (n > 0) readline.moveCursor(process.stdout, 0, n);
}
export function cursorToCol0(): void {
  readline.cursorTo(process.stdout, 0);
}
export function cursorToCol(n: number): void {
  readline.cursorTo(process.stdout, n);
}
export function clearToEnd(): void {
  process.stdout.write("\x1b[J");
}
export function clearLine(): void {
  readline.clearLine(process.stdout, 0);
}

// ─── DEC cursor save / restore ───

/** DEC private save cursor position (more widely supported than CSI s). */
export function saveCursorDEC(): void {
  process.stdout.write("\x1b7");
}
/** DEC private restore cursor position. */
export function restoreCursorDEC(): void {
  process.stdout.write("\x1b8");
}

// ─── Scroll region ───

/** Set scroll region to rows [top, bottom] (1-indexed). */
export function setScrollRegion(top: number, bottom: number): void {
  process.stdout.write(`\x1b[${top};${bottom}r`);
}
/** Reset scroll region to full screen. */
export function resetScrollRegion(): void {
  process.stdout.write("\x1b[r");
}

// ─── Absolute positioning ───

/** Move cursor to absolute row (1-indexed), column 1. */
export function gotoRow(row: number): void {
  process.stdout.write(`\x1b[${row};1H`);
}
/** Clear entire screen and move cursor to (1,1). */
export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

// ─── String width ───

/**
 * Calculate the visible display width of a string, counting wide (CJK/fullwidth)
 * characters as 2 columns and stripping ANSI escape codes first.
 */
export function calcDisplayWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      cp === 0x2329 || cp === 0x232A  ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3040 && cp <= 0xA4CF) ||
      (cp >= 0xA960 && cp <= 0xA97F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xD7B0 && cp <= 0xD7FF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1B000 && cp <= 0x1B12F) ||
      (cp >= 0x1F004 && cp <= 0x1F0CF) ||
      (cp >= 0x1F200 && cp <= 0x1FFFF) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    ) {
      w += 2;
    } else if (cp >= 0x0300 && cp <= 0x036F) {
      // combining diacriticals — zero width
    } else if (cp > 0) {
      w += 1;
    }
  }
  return w;
}
