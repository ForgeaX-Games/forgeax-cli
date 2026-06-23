import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { isXtermJs } from '../ink/terminal.js'

// OSC 8 hyperlink escape sequences
// Format: \e]8;;URL\e\\TEXT\e]8;;\e\\
// Using \x07 (BEL) as terminator which is more widely supported
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks)
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    return url
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)

  // xterm.js (VS Code, Cursor, Windsurf) re-evaluates OSC 8 link hover
  // decorations on every buffer write — even atomic BSU/ESU frames that
  // don't touch the link cells. Periodic renders (spinner tick ~80ms)
  // cause the decoration to flicker. Skip the OSC 8 wrapper; xterm.js
  // detects URLs natively for Ctrl+Click and the app already defers
  // link-opening to the terminal in xterm.js environments (App.tsx).
  if (isXtermJs()) {
    return coloredText
  }

  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}

