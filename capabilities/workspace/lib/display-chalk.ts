import { Chalk } from "chalk";

/**
 * Chalk instance with forced color output (level 1 = basic 16-color ANSI).
 *
 * formatDisplay() runs inside the Gateway process whose stdout may not be a
 * TTY, causing the default chalk singleton to auto-detect level 0 (no color).
 * visual_display strings are consumed by the ink-renderer which expects ANSI
 * escapes for DiffAwareLine detection, so we must guarantee they are present.
 */
export const displayChalk = new Chalk({ level: 1 });
