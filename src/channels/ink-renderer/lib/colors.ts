/**
 * Centralized color constants for the Ink renderer.
 *
 * Ink's `<Text color=...>` only accepts the `ansi:xxx` format, NOT bare names
 * like "green" or "red". This module provides typed constants so every color
 * reference goes through one place — preventing silent rendering failures.
 */

import type { AnsiColor } from "../ink/styles.js";

export const C = {
  black:         "ansi:black"         as AnsiColor,
  red:           "ansi:red"           as AnsiColor,
  green:         "ansi:green"         as AnsiColor,
  yellow:        "ansi:yellow"        as AnsiColor,
  blue:          "ansi:blue"          as AnsiColor,
  magenta:       "ansi:magenta"       as AnsiColor,
  cyan:          "ansi:cyan"          as AnsiColor,
  white:         "ansi:white"         as AnsiColor,
  blackBright:   "ansi:blackBright"   as AnsiColor,
  redBright:     "ansi:redBright"     as AnsiColor,
  greenBright:   "ansi:greenBright"   as AnsiColor,
  yellowBright:  "ansi:yellowBright"  as AnsiColor,
  blueBright:    "ansi:blueBright"    as AnsiColor,
  magentaBright: "ansi:magentaBright" as AnsiColor,
  cyanBright:    "ansi:cyanBright"    as AnsiColor,
  whiteBright:   "ansi:whiteBright"   as AnsiColor,
} as const;

export type ColorName = keyof typeof C;
